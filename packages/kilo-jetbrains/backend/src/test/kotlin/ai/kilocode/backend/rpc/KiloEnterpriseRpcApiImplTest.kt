package ai.kilocode.backend.rpc

import ai.kilocode.backend.app.KiloAppState
import ai.kilocode.backend.app.KiloBackendAppService
import ai.kilocode.backend.testing.FakeCliServer
import ai.kilocode.backend.testing.MockCliServer
import ai.kilocode.backend.testing.TestLog
import ai.kilocode.rpc.dto.EnterpriseOrgDto
import ai.kilocode.rpc.dto.EnterprisePolicyDto
import ai.kilocode.rpc.dto.EnterpriseSigninDto
import ai.kilocode.rpc.dto.EnterpriseSigninRequestDto
import ai.kilocode.rpc.dto.EnterpriseUserDto
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class KiloEnterpriseRpcApiImplTest {

    private val mock = MockCliServer()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @AfterTest
    fun tearDown() {
        scope.cancel()
        mock.close()
    }

    @Test
    fun `status is unavailable when the CLI has no organization routes`() = runBlocking {
        val status = rpc().status()

        assertFalse(status.available)
        assertFalse(status.enabled)
    }

    @Test
    fun `status maps what the CLI reports`() = runBlocking {
        mock.enterpriseStatus = """
            {
              "enabled": true,
              "source": "managed",
              "url": "https://ai.acme.com",
              "org": {"slug": "acme", "name": "Acme"},
              "required": true,
              "user": {"email": "dev@acme.com", "role": "member"},
              "policy": {"version": 7, "fetched": 1761230000000},
              "blocked": "Your daily organization AI budget of ${'$'}5.00 has been reached",
              "error": "Could not reach https://ai.acme.com",
              "gateway": ["anthropic", "openai"],
              "signin": {"url": "https://ai.acme.com", "org": "acme", "code": "WXYZ-1234", "verification": "https://ai.acme.com/device", "link": "https://ai.acme.com/device?code=WXYZ-1234", "expires": 1761230600000},
              "future": "ignored"
            }
        """.trimIndent()

        val status = rpc().status()

        assertTrue(status.available)
        assertTrue(status.enabled)
        assertTrue(status.required)
        assertEquals("managed", status.source)
        assertEquals("https://ai.acme.com", status.url)
        assertEquals(EnterpriseOrgDto("acme", "Acme"), status.org)
        assertEquals(EnterpriseUserDto("dev@acme.com", "member"), status.user)
        assertEquals(EnterprisePolicyDto(7, 1761230000000), status.policy)
        assertEquals("Your daily organization AI budget of \$5.00 has been reached", status.blocked)
        assertEquals("Could not reach https://ai.acme.com", status.error)
        assertEquals(listOf("anthropic", "openai"), status.gateway)
        assertEquals(
            EnterpriseSigninDto("WXYZ-1234", "https://ai.acme.com/device?code=WXYZ-1234", 1761230600000),
            status.signin,
        )
    }

    @Test
    fun `signin sends only the server and organization that were entered`() = runBlocking {
        mock.enterpriseSignin = """{"enabled":false,"required":false,"gateway":[],"signin":{"url":"https://ai.acme.com","org":"acme","code":"ABCD","verification":"v","link":"https://ai.acme.com/device?code=ABCD","expires":1761230600000}}"""
        val rpc = rpc()

        val started = rpc.signin(EnterpriseSigninRequestDto(url = " https://ai.acme.com ", org = "acme"))
        assertEquals("""{"url":"https://ai.acme.com","org":"acme"}""", mock.lastEnterpriseSigninBody)
        assertEquals("ABCD", started.status?.signin?.code)
        assertNull(started.error)

        // An enrolled device names neither: the CLI signs in to its own organization.
        rpc.signin(EnterpriseSigninRequestDto())
        assertEquals("{}", mock.lastEnterpriseSigninBody)
    }

    @Test
    fun `signin passes the CLI's reason through`() = runBlocking {
        mock.enterpriseSigninStatus = 400
        mock.enterpriseSignin = """{"name":"EnterpriseSigninError","message":"No organization acme on https://ai.acme.com."}"""

        val result = rpc().signin(EnterpriseSigninRequestDto(url = "https://ai.acme.com", org = "acme"))

        assertNull(result.status)
        assertEquals("No organization acme on https://ai.acme.com.", result.error)
    }

    @Test
    fun `an approved sign-in reloads the CLI so the policy takes effect`() = runBlocking {
        mock.enterpriseWait = """{"enabled":true,"required":true,"gateway":[],"org":{"slug":"acme"},"user":{"email":"dev@acme.com","role":"member"}}"""
        val rpc = rpc()
        val before = mock.requestCount("/global/dispose")

        val done = rpc.finish()

        assertEquals("dev@acme.com", done.status?.user?.email)
        assertEquals(before + 1, mock.requestCount("/global/dispose"))
    }

    @Test
    fun `a denied sign-in reports why and reloads nothing`() = runBlocking {
        mock.enterpriseWaitStatus = 400
        mock.enterpriseWait = """{"name":"EnterpriseSigninError","message":"Sign-in was denied."}"""
        mock.enterpriseStatus = """{"enabled":true,"required":true,"gateway":[]}"""
        val rpc = rpc()
        val before = mock.requestCount("/global/dispose")

        val done = rpc.finish()

        assertNull(done.status)
        assertEquals("Sign-in was denied.", done.error)
        assertEquals(before, mock.requestCount("/global/dispose"))
    }

    @Test
    fun `a sign-in another window completed first still counts`() = runBlocking {
        mock.enterpriseWaitStatus = 400
        mock.enterpriseWait = """{"name":"EnterpriseSigninError","message":"A newer sign-in replaced this one."}"""
        mock.enterpriseStatus = """{"enabled":true,"required":true,"gateway":[],"user":{"email":"dev@acme.com","role":"member"}}"""
        val rpc = rpc()
        val before = mock.requestCount("/global/dispose")

        val done = rpc.finish()

        assertEquals("dev@acme.com", done.status?.user?.email)
        assertNull(done.error)
        assertEquals(before + 1, mock.requestCount("/global/dispose"))
    }

    @Test
    fun `signout reloads the CLI without the organization's policy`() = runBlocking {
        val rpc = rpc()
        val before = mock.requestCount("/global/dispose")

        val result = rpc.signout()

        assertFalse(result.status!!.enabled)
        assertEquals(before + 1, mock.requestCount("/global/dispose"))
    }

    private suspend fun rpc(): KiloEnterpriseRpcApiImpl = KiloEnterpriseRpcApiImpl(app())

    private suspend fun app(): KiloBackendAppService {
        val app = KiloBackendAppService.create(scope, FakeCliServer(mock), TestLog())
        app.connect()
        withTimeout(10_000) {
            app.appState.first { it is KiloAppState.Ready }
        }
        return app
    }
}
