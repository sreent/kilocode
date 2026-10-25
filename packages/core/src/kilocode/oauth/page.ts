export * as KiloOauthCallbackPage from "./page"

import { OauthCallbackPage, type CallbackPageOptions } from "../../oauth/page"
import { mark } from "../../../../../brand/icons/svg"
import { Brand } from "../../tucode/brand"

const MARK = `<svg class="wordmark" xmlns="http://www.w3.org/2000/svg" viewBox="${mark.viewBox}" fill="none" aria-label="${Brand.name}" role="img">${mark.body}</svg>`

function brand(page: string) {
  return page.replace(/<svg class="wordmark"[\s\S]*?<\/svg>/, MARK).replaceAll("OpenCode", Brand.name)
}

export function success(options?: CallbackPageOptions) {
  return brand(OauthCallbackPage.success(options))
}

export function error(detail: string, options?: CallbackPageOptions) {
  return brand(OauthCallbackPage.error(detail, options))
}
