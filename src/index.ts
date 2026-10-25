// Server-side entry: the registry, the handler, the identity helper and the
// config wrapper. The client component is exported from `@faustine-ai/next/client`
// so the server bundle never pulls React or the widget loader.
export {
  createRegistry,
  isOperationName,
  registryHash,
  REGISTRY_FORMAT_VERSION,
  type OperationBinding,
  type OperationFn,
  type OperationName,
  type OperationParam,
  type OperationParamKind,
  type OperationSchema,
  type Registry,
  type RegistryMeta,
} from './registry';
export {
  argumentsFor,
  callOperation,
  createFaustineHandler,
  detectBuildSha,
  originAllowed,
  structuredNextError,
  toFormData,
  ManifestClient,
  type FaustineHandlerOptions,
  type ManifestResponse,
  type ServedManifest,
} from './handler';
export { faustineIdentityToken, type IdentityTokenOptions, type IdentityUser } from './identity';
export { withFaustine } from './with-faustine';
