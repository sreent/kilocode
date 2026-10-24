package ai.kilocode.rpc

import ai.kilocode.rpc.dto.OrganizationResultDto
import ai.kilocode.rpc.dto.OrganizationSigninRequestDto
import ai.kilocode.rpc.dto.OrganizationStatusDto
import com.intellij.platform.rpc.RemoteApiProviderService
import fleet.rpc.RemoteApi
import fleet.rpc.Rpc
import fleet.rpc.remoteApiDescriptor

/**
 * Self-hosted organization sign-in and status, exposed from backend to frontend.
 *
 * Enrollment is per device and the CLI owns it, so these are project-neutral. A sign-in or sign-out
 * changes the policy that decides which providers, models and agents exist, and reloads them.
 */
@Rpc
interface KiloOrganizationRpcApi : RemoteApi<Unit> {
    companion object {
        suspend fun getInstance(): KiloOrganizationRpcApi {
            return RemoteApiProviderService.resolve(remoteApiDescriptor<KiloOrganizationRpcApi>())
        }
    }

    /** The organization status; not [OrganizationStatusDto.available] when the CLI has no organization support. */
    suspend fun status(): OrganizationStatusDto

    /** Start a device sign-in. The status carries the code and link the person confirms in the browser. */
    suspend fun signin(request: OrganizationSigninRequestDto): OrganizationResultDto

    /** Block until the waiting sign-in is approved, denied or expires. */
    suspend fun finish(): OrganizationResultDto

    /** Sign out of the organization and drop its policy. */
    suspend fun signout(): OrganizationResultDto
}
