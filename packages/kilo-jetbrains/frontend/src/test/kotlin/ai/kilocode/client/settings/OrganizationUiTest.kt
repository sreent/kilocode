package ai.kilocode.client.settings

import ai.kilocode.client.app.KiloOrganizationService
import ai.kilocode.client.settings.profile.OrgMode
import ai.kilocode.client.settings.profile.OrganizationUi
import ai.kilocode.client.testing.FakeOrganizationRpcApi
import ai.kilocode.client.testing.TestCoroutines
import ai.kilocode.client.testing.TestUiTimers
import ai.kilocode.client.util.edtWait
import ai.kilocode.rpc.dto.OrganizationNameDto
import ai.kilocode.rpc.dto.OrganizationPolicyDto
import ai.kilocode.rpc.dto.OrganizationResultDto
import ai.kilocode.rpc.dto.OrganizationSigninRequestDto
import ai.kilocode.rpc.dto.OrganizationStatusDto
import ai.kilocode.rpc.dto.OrganizationUserDto
import com.intellij.openapi.util.text.StringUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import kotlinx.coroutines.CompletableDeferred
import java.awt.Container
import javax.swing.AbstractButton
import javax.swing.JLabel

@Suppress("UnstableApiUsage")
class OrganizationUiTest : BasePlatformTestCase() {

    private lateinit var coroutines: TestCoroutines
    private lateinit var rpc: FakeOrganizationRpcApi
    private lateinit var panel: OrganizationUi
    private val urls = mutableListOf<String>()

    private val enrolled = OrganizationStatusDto(
        enabled = true,
        source = "managed",
        url = "https://ai.acme.com",
        org = OrganizationNameDto("acme", "Acme"),
        required = true,
        blocked = "Sign in to Acme to use Kilo.",
    )
    private val signedIn = enrolled.copy(
        source = "login",
        user = OrganizationUserDto("dev@acme.com", "member"),
        blocked = null,
    )

    override fun setUp() {
        super.setUp()
        coroutines = TestCoroutines()
        rpc = FakeOrganizationRpcApi()
    }

    override fun tearDown() {
        try {
            if (::panel.isInitialized) edt { panel.dispose() }
            coroutines.close()
        } finally {
            super.tearDown()
        }
    }

    fun `test stays hidden when the CLI has no organization support`() {
        load(OrganizationStatusDto(available = false))

        edt {
            assertEquals(OrgMode.HIDDEN, panel.mode)
            assertFalse(panel.isVisible)
        }
    }

    fun `test stays hidden when the status cannot be read`() {
        rpc.statusError = IllegalStateException("Kilo HTTP client is unavailable")
        load(enrolled)

        edt {
            assertEquals(OrgMode.HIDDEN, panel.mode)
            assertFalse(panel.isVisible)
        }
    }

    fun `test a device that is not enrolled can sign in to an organization`() {
        rpc.finishGate = CompletableDeferred()
        rpc.finishResult = OrganizationResultDto(status = signedIn)
        load(OrganizationStatusDto())

        edt {
            assertEquals(OrgMode.OFFER, panel.mode)
            assertTrue(panel.isVisible)
            panel.connectLink.doClick()
            assertEquals(OrgMode.FORM, panel.mode)
            assertFalse(panel.formSigninBtn.isEnabled)
            panel.urlField.text = " https://ai.acme.com "
            assertFalse(panel.formSigninBtn.isEnabled)
            panel.orgField.text = "acme"
            assertTrue(panel.formSigninBtn.isEnabled)
            panel.formSigninBtn.doClick()
        }
        waitFor(OrgMode.PENDING)

        assertEquals(listOf(OrganizationSigninRequestDto(url = "https://ai.acme.com", org = "acme")), rpc.signins)
        assertEquals(listOf(rpc.code.link), urls)
        edt {
            val t = text(panel)
            assertTrue(t, t.contains("Sign in to acme"))
            assertTrue(t, t.contains("W X Y Z 1 2 3 4"))
        }

        rpc.finishGate!!.complete(Unit)
        waitFor(OrgMode.SIGNED_IN)
        edt {
            val t = text(panel)
            assertTrue(t, t.contains("Acme"))
            assertTrue(t, t.contains("Signed in as dev@acme.com (member)"))
            assertTrue(buttons(panel).any { it.text == "Sign Out" })
        }
    }

    fun `test an enrolled device signs in to its own organization`() {
        rpc.finishGate = CompletableDeferred()
        load(enrolled)

        edt {
            assertEquals(OrgMode.ENROLLED, panel.mode)
            val t = text(panel)
            assertTrue(t, t.contains("Acme manages TU Code on this device."))
            panel.signinBtn.doClick()
        }
        waitFor(OrgMode.PENDING)

        assertEquals(listOf(OrganizationSigninRequestDto()), rpc.signins)
        edt { assertTrue(text(panel).contains("Sign in to Acme")) }
    }

    fun `test cancel stops waiting and a cancelled code is not shown again`() {
        rpc.finishGate = CompletableDeferred()
        load(enrolled)
        edt { panel.signinBtn.doClick() }
        assertTrue(coroutines.pumpUntil { edt { panel.mode == OrgMode.PENDING } && rpc.finishCalls == 1 })

        edt { buttons(panel).first { it.text == "Cancel" }.doClick() }
        coroutines.drain()
        edt { assertEquals(OrgMode.ENROLLED, panel.mode) }

        // The CLI keeps reporting the cancelled sign-in until its code expires.
        rpc.status = enrolled.copy(signin = rpc.code)
        edt { panel.load() }
        coroutines.drain()
        edt { assertEquals(OrgMode.ENROLLED, panel.mode) }
    }

    fun `test a failed sign-in shows the CLI's reason and can be tried again`() {
        rpc.finishResult = OrganizationResultDto(error = "Sign-in was denied.")
        load(enrolled)

        edt { panel.signinBtn.doClick() }
        waitFor(OrgMode.FAILED)
        edt {
            assertTrue(text(panel).contains("Sign-in was denied."))
            buttons(panel).first { it.text == "Try Again" }.doClick()
        }

        assertTrue(coroutines.pumpUntil { rpc.signins.size == 2 && edt { panel.mode == OrgMode.FAILED } })
    }

    fun `test signed in shows the policy in force and why the agent is blocked`() {
        load(
            signedIn.copy(
                policy = OrganizationPolicyDto(7, 1761230000000),
                gateway = listOf("anthropic", "openai"),
                blocked = "Your daily organization AI budget of \$5.00 has been reached (\$5.12 spent).",
                error = "Could not reach https://ai.acme.com",
            ),
        )

        edt {
            assertEquals(OrgMode.SIGNED_IN, panel.mode)
            val t = text(panel)
            assertTrue(t, t.contains("ORGANIZATION"))
            assertTrue(t, t.contains("Signed in as dev@acme.com (member)"))
            assertTrue(t, t.contains("Policy version 7, updated"))
            assertTrue(t, t.contains("Model calls to anthropic, openai go through your organization's gateway."))
            assertTrue(t, t.contains("budget of \$5.00 has been reached (\$5.12 spent)."))
            assertTrue(t, t.contains("Last policy refresh failed: Could not reach https://ai.acme.com"))
        }
    }

    fun `test an organization set by environment variables cannot be signed out of here`() {
        load(signedIn.copy(source = "env"))

        edt {
            assertEquals(OrgMode.SIGNED_IN, panel.mode)
            assertFalse(buttons(panel).any { it.text == "Sign Out" })
        }
    }

    fun `test sign out shows the status the CLI returns`() {
        rpc.signoutResult = OrganizationResultDto(status = OrganizationStatusDto())
        load(signedIn)

        edt { panel.signoutBtn.doClick() }
        waitFor(OrgMode.OFFER)

        assertEquals(1, rpc.signoutCalls)
    }

    // -- helpers --

    private fun load(status: OrganizationStatusDto) {
        rpc.status = status
        edt {
            panel = OrganizationUi(
                coroutines.scope,
                KiloOrganizationService(rpc),
                browse = { urls.add(it) },
                timers = TestUiTimers(),
            )
            panel.load()
        }
        coroutines.drain()
    }

    private fun waitFor(mode: OrgMode) {
        assertTrue("never reached $mode", coroutines.pumpUntil { edt { panel.mode == mode } })
    }

    private fun <T> edt(block: () -> T): T = edtWait(block)

    private fun buttons(root: Container): List<AbstractButton> = buildList {
        for (comp in root.components) {
            if (!comp.isVisible) continue
            if (comp is AbstractButton) add(comp)
            if (comp is Container) addAll(buttons(comp))
        }
    }

    // Visible text, with the HTML that wrapping labels carry removed.
    private fun text(root: Container): String = buildList {
        fun collect(parent: Container) {
            for (comp in parent.components) {
                if (!comp.isVisible) continue
                when (comp) {
                    is AbstractButton -> comp.text?.let { add(it) }
                    is JLabel -> comp.text?.let { add(StringUtil.unescapeXmlEntities(StringUtil.removeHtmlTags(it))) }
                }
                if (comp is Container) collect(comp)
            }
        }
        collect(root)
    }.joinToString("\n")
}
