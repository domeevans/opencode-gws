import type { RequestInput } from "../../src/domain/contract.js"
import type { Request } from "../../src/domain/types.js"
import { ACCOUNT } from "./config.js"

/**
 * Request builders keyed by operation id: a manifest method id such as
 * "gmail.users.messages.list" or a helper id such as "gmail.triage". They
 * emit the current request shape, so a contract change touches only this
 * file.
 */

export type RequestExtras = Partial<Omit<RequestInput, "operation">>

/** A request for one operation id on the `personal` account unless `extras.account` names another. */
export function request(id: string, extras: RequestExtras = {}): Request {
  const { account = ACCOUNT, ...rest } = extras
  return { ...rest, account, operation: id }
}
