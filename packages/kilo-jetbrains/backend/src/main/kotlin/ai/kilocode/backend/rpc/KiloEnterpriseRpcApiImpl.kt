@file:Suppress("UnstableApiUsage")

package ai.kilocode.backend.rpc

import ai.kilocode.backend.app.KiloBackendAppService
import ai.kilocode.backend.enterprise.KiloBackendEnterpriseManager
import ai.kilocode.rpc.KiloEnterpriseRpcApi
import ai.kilocode.rpc.dto.EnterpriseResultDto
import ai.kilocode.rpc.dto.EnterpriseSigninRequestDto
import ai.kilocode.rpc.dto.EnterpriseStatusDto

class KiloEnterpriseRpcApiImpl(
    backend: KiloBackendAppService? = null,
    private val manager: KiloBackendEnterpriseManager = KiloBackendEnterpriseManager(backend),
) : KiloEnterpriseRpcApi {
    override suspend fun status(): EnterpriseStatusDto = manager.status()

    override suspend fun signin(request: EnterpriseSigninRequestDto): EnterpriseResultDto = manager.signin(request)

    override suspend fun finish(): EnterpriseResultDto = manager.finish()

    override suspend fun signout(): EnterpriseResultDto = manager.signout()
}
