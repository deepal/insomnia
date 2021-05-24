import { distinctByProperty, getPluginNameFromKey, isPluginKey } from '../common';
import { DCPlugin, DCPluginConfig } from '../types/declarative-config';
import { OA3Operation, OpenApi3Spec, OA3PathItem, OA3RequestBody, OA3Parameter } from '../types/openapi3';

export function isRequestValidatorPluginKey(key: string): boolean {
  return key.match(/-request-validator$/) != null;
}

export function generatePlugins(item: Record<string, any>, tags?: string[]): DCPlugin[] {
  // When generating plugins, ignore the request validator plugin because it is handled at the operation level
  const pluginFilter = ([key]: [string, any]) => isPluginKey(key) && !isRequestValidatorPluginKey(key);

  // Server plugins should load from the api spec root and from the server
  return Object.entries(item)
    .filter(pluginFilter)
    .map(e => generatePlugin(e, tags));
}

function generatePlugin([key, value]: [string, Record<string, any>], tags?: string[]) {
  const plugin: DCPlugin = {
    name: value.name || getPluginNameFromKey(key),
  };

  if (value.config) {
    plugin.config = value.config;
  }

  // Add tags to plugins while appending defaults tags
  plugin.tags = [...(tags || []), ...(value.tags ?? [])];
  return plugin;
}

/**
  This is valid config to allow all content to pass
  See: https://github.com/Kong/kong-plugin-enterprise-request-validator/pull/34/files#diff-1a1d2d5ce801cc1cfb2aa91ae15686d81ef900af1dbef00f004677bc727bfd3cR284
 */
const ALLOW_ALL_SCHEMA = '{}';

const DEFAULT_PARAM_STYLE = {
  header: 'simple',
  cookie: 'form',
  query: 'form',
  path: 'simple',
};

const generateParameterSchema = (operation?: OA3Operation) => {
  if (!operation?.parameters?.length) {
    return undefined;
  }

  const parameterSchema: OA3Parameter[] = [];
  for (const parameter of operation.parameters as OA3Parameter[]) {
    // The following is valid config to allow all content to pass, in the case where schema is not defined
    let schema = '';

    if (parameter.schema) {
      schema = JSON.stringify(parameter.schema);
    } else if (parameter.content) {
      // only parameters defined with a schema (not content) are supported
      schema = ALLOW_ALL_SCHEMA;
    } else {
      // no schema or content property on a parameter is in violation with the OpenAPI spec
      schema = ALLOW_ALL_SCHEMA;
    }

    const paramStyle = parameter.style ?? DEFAULT_PARAM_STYLE[parameter.in];

    if (typeof paramStyle === 'undefined') {
      const name = parameter.name;
      throw new Error(`invalid 'in' property (parameter '${name}')`);
    }

    parameterSchema.push({
      in: parameter.in,
      explode: !!parameter.explode,
      required: !!parameter.required,
      name: parameter.name,
      schema,
      style: paramStyle,
    });
  }

  return parameterSchema;
};

function generateBodyOptions(operation?: OA3Operation) {
  let bodySchema;
  let allowedContentTypes;
  const bodyContent = (operation?.requestBody as OA3RequestBody)?.content;

  if (bodyContent) {
    const jsonContentType = 'application/json';
    allowedContentTypes = Object.keys(bodyContent);

    if (allowedContentTypes.includes(jsonContentType)) {
      const item = bodyContent[jsonContentType];
      bodySchema = JSON.stringify(item.schema);
    }
  }

  return {
    bodySchema,
    allowedContentTypes,
  };
}

export function generateRequestValidatorPlugin(
  plugin: Record<string, any>,
  operation?: OA3Operation,
  tags?: string[],
) {
  const config: DCPluginConfig = {
    version: 'draft4', // Fixed version
  };

  const pluginConfig = plugin.config ?? {};

  // Use original or generated parameter_schema
  const parameterSchema = pluginConfig.parameter_schema ?? generateParameterSchema(operation);
  const generated = generateBodyOptions(operation);

  // Use original or generated body_schema
  let bodySchema = pluginConfig.body_schema ?? generated.bodySchema;

  // If no parameter_schema or body_schema is defined or generated, allow all content to pass
  if (parameterSchema === undefined && bodySchema === undefined) {
    bodySchema = ALLOW_ALL_SCHEMA;
  }

  // Apply parameter_schema and body_schema to the config object
  if (parameterSchema !== undefined) {
    config.parameter_schema = parameterSchema;
  }

  if (bodySchema !== undefined) {
    config.body_schema = bodySchema;
  }

  // Use original or generated allowed_content_types
  const allowedContentTypes = pluginConfig.allowed_content_types ?? generated.allowedContentTypes;

  if (allowedContentTypes !== undefined) {
    config.allowed_content_types = allowedContentTypes;
  }

  // Use original verbose_response if defined
  if (pluginConfig.verbose_response !== undefined) {
    config.verbose_response = Boolean(pluginConfig.verbose_response);
  }

  const dcPlugin: DCPlugin = {
    config,
    tags: [...(tags ?? []), ...(plugin.tags ?? [])],
    enabled: Boolean(plugin.enabled ?? true),
    name: 'request-validator',
  };
  return dcPlugin;
}

export function generateGlobalPlugins(
  api: OpenApi3Spec,
  tags: string[],
) {
  const globalPlugins = generatePlugins(api, tags);
  const requestValidatorPlugin = getRequestValidatorPluginDirective(api);

  if (requestValidatorPlugin) {
    globalPlugins.push(generateRequestValidatorPlugin(requestValidatorPlugin, undefined, tags));
  }

  return {
    // Server plugins take precedence over global plugins
    plugins: distinctByProperty<DCPlugin>(globalPlugins, plugin => plugin.name),
    requestValidatorPlugin,
  };
}

export function generatePathPlugins(pathItem: OA3PathItem, tags: string[]): DCPlugin[] {
  return generatePlugins(pathItem, tags);
}

export function generateOperationPlugins(
  operation: OA3Operation,
  pathPlugins: DCPlugin[],
  parentValidatorPlugin?: Record<string, any> | null,
  tags?: string[],
) {
  const operationPlugins: DCPlugin[] = generatePlugins(operation, tags);
  // Check if validator plugin exists on the operation
  const operationValidatorPlugin = getRequestValidatorPluginDirective(operation);
  // Use the operation or parent validator plugin, or skip if neither exist
  const validatorPluginToUse = operationValidatorPlugin || parentValidatorPlugin;

  if (validatorPluginToUse) {
    operationPlugins.push(generateRequestValidatorPlugin(validatorPluginToUse, operation, tags));
  }

  // Operation plugins take precedence over path plugins
  return distinctByProperty<DCPlugin>([...operationPlugins, ...pathPlugins], plugin => plugin.name);
}

export function getRequestValidatorPluginDirective(obj: Record<string, any>) {
  const key = Object.keys(obj).filter(isPluginKey).find(isRequestValidatorPluginKey);
  // If the key is defined but is blank (therefore should be fully generated) then default to {}
  return key ? (obj[key] || {}) as Record<string, any> : null;
}