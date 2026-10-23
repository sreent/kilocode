package ai.kilocode.rpc

import ai.kilocode.rpc.dto.EnterpriseResultDto
import ai.kilocode.rpc.dto.EnterpriseSigninRequestDto
import ai.kilocode.rpc.dto.EnterpriseStatusDto
import com.intellij.platform.rpc.RemoteApiProviderService
import fleet.rpc.RemoteApi
import fleet.rpc.Rpc
import fleet.rpc.remoteApiDescriptor

/**
 * Self-hosted organization (enterprise) sign-in and status, exposed from backend to frontend.
 *
 * Enrollment is per device and the CLI owns it, so these are project-neutral. A sign-in or sign-out
 * changes the policy that decides which providers, models and agents exist, and reloads them.
 */
@Rpc
interface KiloEnterpriseRpcApi : RemoteApi<Unit> {
    companion object {
        suspend fun getInstance(): KiloEnterpriseRpcApi {
            return RemoteApiProviderService.resolve(remoteApiDescriptor<KiloEnterpriseRpcApi>())
        }
    }

    /** The organization status; not [EnterpriseStatusDto.available] when the CLI has no organization support. */
    suspend fun status(): EnterpriseStatusDto

    /** Start a device sign-in. The status carries the code and link the person confirms in the browser. */
    suspend fun signin(request: EnterpriseSigninRequestDto): EnterpriseResultDto

    /** Block until the waiting sign-in is approved, denied or expires. */
    suspend fun finish(): EnterpriseResultDto

    /** Sign out of the organization and drop its policy. */
    suspend fun signout(): EnterpriseResultDto
}
