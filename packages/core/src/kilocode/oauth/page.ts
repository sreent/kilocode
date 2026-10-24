export * as KiloOauthCallbackPage from "./page"

import { OauthCallbackPage, type CallbackPageOptions } from "../../oauth/page"
import { Brand } from "../../tucode/brand"

const MARK = `<svg class="wordmark" xmlns="http://www.w3.org/2000/svg" viewBox="56 104 400 304" fill="none" aria-label="${Brand.name}" role="img">
        <path fill="currentColor" d="M72 120H240V176H184V392H128V176H72V120ZM272 120H328V336H384V120H440V352L400 392H312L272 352V120Z"/>
      </svg>`

function brand(page: string) {
  return page.replace(/<svg class="wordmark"[\s\S]*?<\/svg>/, MARK).replaceAll("OpenCode", Brand.name)
}

export function success(options?: CallbackPageOptions) {
  return brand(OauthCallbackPage.success(options))
}

export function error(detail: string, options?: CallbackPageOptions) {
  return brand(OauthCallbackPage.error(detail, options))
}
