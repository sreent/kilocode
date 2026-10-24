package ai.kilocode.rpc.dto

import kotlinx.serialization.Serializable

/**
 * The self-hosted organization this device is enrolled in, as `kilo serve` reports it.
 *
 * [available] is false when the running CLI has no organization support (a CLI release without the
 * self-hosted organization routes); the profile then shows nothing about organizations.
 */
@Serializable
data class OrganizationStatusDto(
    val available: Boolean = true,
    /** False when no organization.json, environment variables or stored sign-in enroll this device. */
    val enabled: Boolean = false,
    /** How the device was enrolled: `managed` (deployed by IT), `env` or `login`. */
    val source: String? = null,
    val url: String? = null,
    val org: OrganizationNameDto? = null,
    /** The agent may not run until the person signs in. */
    val required: Boolean = false,
    val user: OrganizationUserDto? = null,
    val policy: OrganizationPolicyDto? = null,
    /** Why the agent cannot run right now. */
    val blocked: String? = null,
    /** The last policy refresh failure. */
    val error: String? = null,
    /** Providers routed through the organization's LLM gateway. */
    val gateway: List<String> = emptyList(),
    /** A device sign-in waiting for approval in the browser. */
    val signin: OrganizationSigninDto? = null,
)

@Serializable
data class OrganizationNameDto(
    val slug: String,
    val name: String? = null,
)

@Serializable
data class OrganizationUserDto(
    val email: String,
    val role: String,
)

@Serializable
data class OrganizationPolicyDto(
    val version: Int,
    /** When the policy was last fetched, in epoch milliseconds. */
    val fetched: Long,
)

@Serializable
data class OrganizationSigninDto(
    val code: String,
    /** The verification page with the code filled in. */
    val link: String,
    /** When the code stops working, in epoch milliseconds. */
    val expires: Long,
)

/** Start a device sign-in: to the enrolled organization, or to [url] and [org] when not enrolled. */
@Serializable
data class OrganizationSigninRequestDto(
    val url: String? = null,
    val org: String? = null,
)

/** The status after a sign-in or sign-out, or why it failed in the CLI's words. */
@Serializable
data class OrganizationResultDto(
    val status: OrganizationStatusDto? = null,
    val error: String? = null,
)
