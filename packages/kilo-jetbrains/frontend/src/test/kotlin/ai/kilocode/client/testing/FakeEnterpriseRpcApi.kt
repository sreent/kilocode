package ai.kilocode.client.testing

import ai.kilocode.rpc.KiloEnterpriseRpcApi
import ai.kilocode.rpc.dto.EnterpriseResultDto
import ai.kilocode.rpc.dto.EnterpriseSigninDto
import ai.kilocode.rpc.dto.EnterpriseSigninRequestDto
import ai.kilocode.rpc.dto.EnterpriseStatusDto
import kotlinx.coroutines.CompletableDeferred

class FakeEnterpriseRpcApi : KiloEnterpriseRpcApi {
    var status = EnterpriseStatusDto(available = false)
    var statusError: Exception? = null
    var code = EnterpriseSigninDto(
        code = "WXYZ1234",
        link = "https://ai.acme.com/device?code=WXYZ1234",
        expires = System.currentTimeMillis() + 600_000,
    )
    var signinResult: EnterpriseResultDto? = null
    var finishResult = EnterpriseResultDto(error = "Sign-in was denied.")
    var signoutResult = EnterpriseResultDto(status = EnterpriseStatusDto())

    /** Holds [finish] open until completed, so a test can observe the waiting state. */
    var finishGate: CompletableDeferred<Unit>? = null
    val signins = mutableListOf<EnterpriseSigninRequestDto>()
    var finishCalls = 0
        private set
    var signoutCalls = 0
        private set

    override suspend fun status(): EnterpriseStatusDto {
        assertNotEdt("enterprise.status")
        statusError?.let { throw it }
        return status
    }

    // By default a sign-in starts: the status gains the code to confirm.
    override suspend fun signin(request: EnterpriseSigninRequestDto): EnterpriseResultDto {
        assertNotEdt("enterprise.signin")
        signins.add(request)
        return signinResult ?: EnterpriseResultDto(status = status.copy(signin = code))
    }

    override suspend fun finish(): EnterpriseResultDto {
        assertNotEdt("enterprise.finish")
        finishCalls++
        finishGate?.await()
        return finishResult
    }

    override suspend fun signout(): EnterpriseResultDto {
        assertNotEdt("enterprise.signout")
        signoutCalls++
        return signoutResult
    }
}
