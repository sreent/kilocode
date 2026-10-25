import { Component, onMount } from "solid-js"
import { useVSCode } from "../../context/vscode"
import { useLanguage } from "../../context/language"
import OrganizationCard from "./OrganizationCard"
import type { ProfileData, ProviderUsageData, DeviceAuthState } from "../../types/messages"
import { ProviderUsageCards } from "./ProviderUsageCards"

export type { ProfileData }

export interface ProfileViewProps {
  profileData: ProfileData | null | undefined
  deviceAuth: DeviceAuthState
  providerUsage?: ProviderUsageData
  providerUsageLoading?: boolean
  providerUsageError?: string
  onLogin: () => void
  onRequestProviderUsage?: () => void
  onRefreshProviderUsage?: () => void
}

// tucode has no Kilo account, so the profile shows the organization and the usage of the providers
// people connect themselves.
const ProfileView: Component<ProfileViewProps> = (props) => {
  const vscode = useVSCode()
  const language = useLanguage()

  onMount(() => {
    props.onRequestProviderUsage?.()
  })

  const openExternal = (url: string) => {
    vscode.postMessage({ type: "openExternal", url })
  }

  return (
    <div style={{ display: "flex", "flex-direction": "column", height: "100%", "min-height": 0, overflow: "hidden" }}>
      <div
        style={{
          padding: "12px 16px",
          "border-bottom": "1px solid var(--border-weak-base)",
          display: "flex",
          "align-items": "center",
          gap: "8px",
        }}
      >
        <h2 style={{ "font-size": "var(--kilo-font-size-16)", "font-weight": "600", margin: 0 }}>
          {language.t("profile.title")}
        </h2>
      </div>
      <div
        data-profile-scroll
        style={{
          flex: 1,
          "min-height": 0,
          "overflow-y": "auto",
          "overflow-x": "hidden",
          padding: "16px",
          "max-width": "480px",
          margin: "0 auto",
          width: "100%",
          "box-sizing": "border-box",
        }}
      >
        <OrganizationCard />
        <ProviderUsageCards
          data={props.providerUsage}
          loading={props.providerUsageLoading ?? !props.providerUsage}
          error={props.providerUsageError}
          onRefresh={() => props.onRefreshProviderUsage?.()}
          onOpen={openExternal}
          showKiloPass={false}
          onGetKiloPass={() => undefined}
        />
      </div>
    </div>
  )
}

export default ProfileView
