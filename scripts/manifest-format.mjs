/**
 * The stored form of manifest/generated.json, and the full form every
 * reader works with. src/domain/manifest.ts expands it the same way; a test
 * checks the two agree.
 *
 * Stored: minified, with each scope URL once in a top-level `scopes` table
 * and methods naming them by index. A method's `service`, `path` and
 * `method` are its id's parts (`<service>.<path...>.<method>`) and a
 * helper's `service` is its service's alias, so none of them is stored.
 */

/** Full manifest → stored form. Fails if a field could not be derived back. */
export function compactManifest(full) {
  const scopes = [...new Set(full.services.flatMap((service) => service.methods.flatMap((method) => method.scopes)))].sort()
  const index = new Map(scopes.map((scope, position) => [scope, position]))
  const services = full.services.map((service) => ({
    alias: service.alias,
    methods: service.methods.map((method) => {
      const parts = method.id.split(".")
      if (method.service !== service.alias || parts[0] !== service.alias || parts.at(-1) !== method.method || parts.slice(1, -1).join(".") !== method.path.join(".")) {
        throw new Error(`manifest method ${method.id} does not derive from its id`)
      }
      const { id, httpMethod, pathTemplate, category, description, schemaError } = method
      return {
        id,
        httpMethod,
        pathTemplate,
        scopes: method.scopes.map((scope) => index.get(scope)),
        category,
        ...(description !== undefined ? { description } : {}),
        ...(schemaError !== undefined ? { schemaError } : {}),
      }
    }),
    helpers: service.helpers.map(({ service: owner, ...helper }) => {
      if (owner !== service.alias) throw new Error(`manifest helper ${helper.id} belongs to ${owner}, not ${service.alias}`)
      return helper
    }),
  }))
  return { gwsVersion: full.gwsVersion, generatedAt: full.generatedAt, scopes, services }
}

/** Stored form → full manifest. */
export function expandManifest(stored) {
  return {
    gwsVersion: stored.gwsVersion,
    generatedAt: stored.generatedAt,
    services: stored.services.map((service) => ({
      alias: service.alias,
      methods: service.methods.map(({ scopes, ...method }) => {
        const parts = method.id.split(".")
        return { ...method, service: service.alias, path: parts.slice(1, -1), method: parts.at(-1), scopes: scopes.map((position) => stored.scopes[position]) }
      }),
      helpers: service.helpers.map((helper) => ({ ...helper, service: service.alias })),
    })),
  }
}

/** The file's text for a full manifest. */
export function manifestText(full) {
  return `${JSON.stringify(compactManifest(full))}\n`
}
