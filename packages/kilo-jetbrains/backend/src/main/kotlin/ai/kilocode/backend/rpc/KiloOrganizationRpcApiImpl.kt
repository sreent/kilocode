@file:Suppress("UnstableApiUsage")

package ai.kilocode.backend.rpc

import ai.kilocode.backend.app.KiloBackendAppService
import ai.kilocode.backend.organization.KiloBackendOrganizationManager
import ai.kilocode.rpc.KiloOrganizationRpcApi
import ai.kilocode.rpc.dto.OrganizationResultDto
import ai.kilocode.rpc.dto.OrganizationSigninRequestDto
import ai.kilocode.rpc.dto.OrganizationStatusDto

class KiloOrganizationRpcApiImpl(
    backend: KiloBackendAppService? = null,
    private val manager: KiloBackendOrganizationManager = KiloBackendOrganizationManager(backend),
) : KiloOrganizationRpcApi {
    override suspend fun status(): OrganizationStatusDto = manager.status()

    override suspend fun signin(request: OrganizationSigninRequestDto): OrganizationResultDto = manager.signin(request)

    override suspend fun finish(): OrganizationResultDto = manager.finish()

    override suspend fun signout(): OrganizationResultDto = manager.signout()
}
