package ai.kilocode.client.testing

import ai.kilocode.rpc.KiloOrganizationRpcApi
import ai.kilocode.rpc.dto.OrganizationResultDto
import ai.kilocode.rpc.dto.OrganizationSigninDto
import ai.kilocode.rpc.dto.OrganizationSigninRequestDto
import ai.kilocode.rpc.dto.OrganizationStatusDto
import kotlinx.coroutines.CompletableDeferred

class FakeOrganizationRpcApi : KiloOrganizationRpcApi {
    var status = OrganizationStatusDto(available = false)
    var statusError: Exception? = null
    var code = OrganizationSigninDto(
        code = "WXYZ1234",
        link = "https://ai.acme.com/device?code=WXYZ1234",
        expires = System.currentTimeMillis() + 600_000,
    )
    var signinResult: OrganizationResultDto? = null
    var finishResult = OrganizationResultDto(error = "Sign-in was denied.")
    var signoutResult = OrganizationResultDto(status = OrganizationStatusDto())

    /** Holds [finish] open until completed, so a test can observe the waiting state. */
    var finishGate: CompletableDeferred<Unit>? = null
    val signins = mutableListOf<OrganizationSigninRequestDto>()
    var finishCalls = 0
        private set
    var signoutCalls = 0
        private set

    override suspend fun status(): OrganizationStatusDto {
        assertNotEdt("organization.status")
        statusError?.let { throw it }
        return status
    }

    // By default a sign-in starts: the status gains the code to confirm.
    override suspend fun signin(request: OrganizationSigninRequestDto): OrganizationResultDto {
        assertNotEdt("organization.signin")
        signins.add(request)
        return signinResult ?: OrganizationResultDto(status = status.copy(signin = code))
    }

    override suspend fun finish(): OrganizationResultDto {
        assertNotEdt("organization.finish")
        finishCalls++
        finishGate?.await()
        return finishResult
    }

    override suspend fun signout(): OrganizationResultDto {
        assertNotEdt("organization.signout")
        signoutCalls++
        return signoutResult
    }
}
