package ai.kilocode.client.settings.profile

import ai.kilocode.client.plugin.KiloBundle
import ai.kilocode.client.settings.base.KiloReadyConfigurable
import kotlinx.coroutines.CoroutineScope
import javax.swing.JComponent

/**
 * Settings panel for the user profile.
 *
 * Located at Settings -> Tools -> Kilo -> User Profile.
 *
 * Shows the self-hosted organization the device is enrolled in, if any, and signs in to it. tucode
 * has no Kilo account, so Kilo's login, balance, Kilo Pass and account selector ([ProfileUi]) are not
 * shown. This is a status/action panel — it has no persistent settings, so [isModified] always
 * returns false.
 */
class UserProfileConfigurable : KiloReadyConfigurable() {

    private var org: OrganizationUi? = null

    override fun getId(): String = ID

    override fun getDisplayName(): String = KiloBundle.message("settings.profile.displayName")

    override fun createReadyComponent(cs: CoroutineScope): JComponent {
        val organization = OrganizationUi(cs)
        org = organization
        organization.load()
        return organization
    }

    override fun disposeReadyComponent(component: JComponent) {
        val organization = org
        org = null
        organization?.dispose()
    }

    companion object {
        const val ID = "ai.kilocode.jetbrains.settings.profile"
        const val FOCUS_ACCOUNT_COMBO = "kilo.profile.account.combo"
    }
}
