package ai.kilocode.backend.enterprise

import ai.kilocode.backend.app.KiloBackendAppService
import ai.kilocode.backend.cli.KiloBackendHttpClients
import ai.kilocode.log.KiloLog
import ai.kilocode.rpc.dto.EnterpriseOrgDto
import ai.kilocode.rpc.dto.EnterprisePolicyDto
import ai.kilocode.rpc.dto.EnterpriseResultDto
import ai.kilocode.rpc.dto.EnterpriseSigninDto
import ai.kilocode.rpc.dto.EnterpriseSigninRequestDto
import ai.kilocode.rpc.dto.EnterpriseStatusDto
import ai.kilocode.rpc.dto.EnterpriseUserDto
import com.intellij.openapi.components.service
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Talks to the CLI's organization routes under `/kilo/enterprise`, which own the self-hosted
 * enrollment, the device sign-in and the org policy. This manager only proxies the local CLI.
 *
 * Plain HTTP rather than the generated client: the pinned CLI release the client is generated from
 * has no organization routes, and a CLI without them answers 404, which [status] reports as
 * unavailable so the profile shows nothing about organizations.
 */
class KiloBackendEnterpriseManager(private val backend: KiloBackendAppService? = null) {
    private val app: KiloBackendAppService get() = backend ?: service()

    suspend fun status(): EnterpriseStatusDto {
        val reply = send(Request.Builder().url(url(PATH_STATUS)).get().build(), CALL_TIMEOUT_SECONDS)
        if (reply.code == 404) return EnterpriseStatusDto(available = false)
        if (!reply.ok) throw IllegalStateException("Organization status failed: ${message(reply)}")
        return decode(reply.text)
    }

    suspend fun signin(input: EnterpriseSigninRequestDto): EnterpriseResultDto {
        val body = buildJsonObject {
            input.url?.trim()?.takeIf { it.isNotEmpty() }?.let { put("url", it) }
            input.org?.trim()?.takeIf { it.isNotEmpty() }?.let { put("org", it) }
        }
        LOG.info("organization sign-in start enrolled=${input.url == null}")
        return result(send(post(PATH_SIGNIN, body), CALL_TIMEOUT_SECONDS))
    }

    /**
     * Wait for the person to approve the sign-in in the browser. The CLI answers once they approve
     * or deny it, or the code expires, so this call has no timeout of its own; cancelling it stops
     * the wait.
     */
    suspend fun finish(): EnterpriseResultDto {
        val result = result(send(post(PATH_WAIT), timeout = null))
        if (result.status != null) return reload(result)
        // Another window may have finished the same sign-in first; what counts is whether we are in.
        val now = runCatching { status() }.getOrNull()
        if (now?.user != null) return reload(EnterpriseResultDto(status = now))
        LOG.info("organization sign-in did not complete: ${result.error}")
        return result
    }

    suspend fun signout(): EnterpriseResultDto =
        reload(result(send(post(PATH_SIGNOUT), CALL_TIMEOUT_SECONDS)))

    // The policy decides which providers, models, agents and MCP servers exist, so a sign-in or
    // sign-out disposes the CLI's instances; the `global.disposed` event that follows reloads the
    // app and workspace data the way a provider change does.
    private suspend fun reload(result: EnterpriseResultDto): EnterpriseResultDto {
        if (result.status == null) return result
        runCatching { send(post(PATH_DISPOSE), CALL_TIMEOUT_SECONDS) }
            .onFailure { LOG.warn("organization reload failed: ${it.message}") }
        return result
    }

    private fun result(reply: Reply): EnterpriseResultDto =
        if (reply.ok) EnterpriseResultDto(status = decode(reply.text))
        else EnterpriseResultDto(error = message(reply))

    /**
     * Decoded into module-local wire types and mapped by hand: a shared DTO's serializer resolves
     * from a different classloader here and fails with a `LinkageError` (see the marketplace manager).
     */
    private fun decode(text: String): EnterpriseStatusDto {
        val wire = JSON.decodeFromString<WireStatus>(text)
        return EnterpriseStatusDto(
            enabled = wire.enabled,
            source = wire.source,
            url = wire.url,
            org = wire.org?.let { EnterpriseOrgDto(it.slug, it.name) },
            required = wire.required,
            user = wire.user?.let { EnterpriseUserDto(it.email, it.role) },
            policy = wire.policy?.let { EnterprisePolicyDto(it.version.toInt(), it.fetched.toLong()) },
            blocked = wire.blocked,
            error = wire.error,
            gateway = wire.gateway,
            signin = wire.signin?.let { EnterpriseSigninDto(it.code, it.link, it.expires.toLong()) },
        )
    }

    // The CLI's own explanation (`{"message": ...}` for sign-in errors) is the only description of
    // what went wrong, so it is passed through.
    private fun message(reply: Reply): String {
        val body = runCatching { JSON.parseToJsonElement(reply.text) as? JsonObject }.getOrNull()
        val text = listOf("message", "error").firstNotNullOfOrNull { key ->
            (body?.get(key) as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
        }
        return text ?: "HTTP ${reply.code}"
    }

    private fun post(path: String, body: JsonObject = JsonObject(emptyMap())): Request =
        Request.Builder().url(url(path)).post(body.toString().toRequestBody(JSON_MEDIA)).build()

    private suspend fun send(request: Request, timeout: Long?): Reply {
        val http = app.http ?: throw IllegalStateException("Kilo HTTP client is unavailable")
        val client = if (timeout == null) http else KiloBackendHttpClients.bounded(http, timeout)
        return client.newCall(request.newBuilder().header("Accept", "application/json").build()).await()
    }

    private suspend fun Call.await(): Reply = suspendCancellableCoroutine { cont ->
        cont.invokeOnCancellation { cancel() }
        enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (!cont.isCancelled) cont.resumeWithException(e)
            }

            override fun onResponse(call: Call, response: Response) {
                val reply = response.use { runCatching { Reply(it.code, it.body.string()) } }
                reply.onSuccess { cont.resume(it) }.onFailure { if (!cont.isCancelled) cont.resumeWithException(it) }
            }
        })
    }

    private fun url(path: String) = "http://127.0.0.1:${app.port}$path"

    private data class Reply(val code: Int, val text: String) {
        val ok get() = code in 200..299
    }

    @Serializable
    private data class WireStatus(
        val enabled: Boolean = false,
        val source: String? = null,
        val url: String? = null,
        val org: WireOrg? = null,
        val required: Boolean = false,
        val user: WireUser? = null,
        val policy: WirePolicy? = null,
        val blocked: String? = null,
        val error: String? = null,
        val gateway: List<String> = emptyList(),
        val signin: WireSignin? = null,
    )

    @Serializable
    private data class WireOrg(val slug: String, val name: String? = null)

    @Serializable
    private data class WireUser(val email: String, val role: String)

    // JSON numbers from the CLI, decoded as doubles so a fractional value never fails the decode.
    @Serializable
    private data class WirePolicy(val version: Double, val fetched: Double)

    @Serializable
    private data class WireSignin(val code: String, val link: String, val expires: Double)

    private companion object {
        val LOG = KiloLog.create(KiloBackendEnterpriseManager::class.java)
        val JSON = Json { ignoreUnknownKeys = true }
        val JSON_MEDIA = "application/json".toMediaType()
        const val CALL_TIMEOUT_SECONDS = 30L
        const val PATH_STATUS = "/kilo/enterprise/status"
        const val PATH_SIGNIN = "/kilo/enterprise/signin"
        const val PATH_WAIT = "/kilo/enterprise/signin/wait"
        const val PATH_SIGNOUT = "/kilo/enterprise/signout"
        const val PATH_DISPOSE = "/global/dispose"
    }
}
