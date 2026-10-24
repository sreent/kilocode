@file:Suppress("UnstableApiUsage")

package ai.kilocode.client.app

import ai.kilocode.log.KiloLog
import ai.kilocode.rpc.KiloOrganizationRpcApi
import ai.kilocode.rpc.dto.OrganizationResultDto
import ai.kilocode.rpc.dto.OrganizationSigninRequestDto
import ai.kilocode.rpc.dto.OrganizationStatusDto
import com.intellij.openapi.components.Service
import fleet.rpc.client.durable
import kotlinx.coroutines.withTimeout

/** Self-hosted organization status and device sign-in, through the backend's CLI. */
@Service(Service.Level.APP)
class KiloOrganizationService internal constructor(
    private val rpc: KiloOrganizationRpcApi?,
) {
    constructor() : this(null)

    companion object {
        private val LOG = KiloLog.create(KiloOrganizationService::class.java)

        // Status and sign-in reach the organization's server through the CLI.
        private const val CALL_TIMEOUT_MS = 45_000L

        // The person has as long as the code lasts to approve it; the CLI answers when they do.
        private const val FINISH_TIMEOUT_MS = 20 * 60_000L
    }

    private suspend fun <T> call(name: String, timeoutMs: Long, block: suspend KiloOrganizationRpcApi.() -> T): T {
        val start = System.currentTimeMillis()
        LOG.info("organization rpc $name: start")
        val api = rpc
        return try {
            val result = withTimeout(timeoutMs) {
                if (api != null) block(api) else durable { block(KiloOrganizationRpcApi.getInstance()) }
            }
            LOG.info("organization rpc $name: completed durationMs=${System.currentTimeMillis() - start}")
            result
        } catch (e: Exception) {
            LOG.warn("organization rpc $name: failed durationMs=${System.currentTimeMillis() - start}", e)
            throw e
        }
    }

    suspend fun status(): OrganizationStatusDto = call("status", CALL_TIMEOUT_MS) { status() }

    /** Sign in to the enrolled organization, or to [url] and [org] when the device is not enrolled. */
    suspend fun signin(url: String?, org: String?): OrganizationResultDto =
        call("signin", CALL_TIMEOUT_MS) { signin(OrganizationSigninRequestDto(url, org)) }

    suspend fun finish(): OrganizationResultDto = call("finish", FINISH_TIMEOUT_MS) { finish() }

    suspend fun signout(): OrganizationResultDto = call("signout", CALL_TIMEOUT_MS) { signout() }
}
