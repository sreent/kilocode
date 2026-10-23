package ai.kilocode.client.settings.profile

import ai.kilocode.client.app.KiloEnterpriseService
import ai.kilocode.client.plugin.KiloBundle
import ai.kilocode.client.settings.auth.DeviceOAuthInfo
import ai.kilocode.client.settings.auth.DeviceOAuthPanel
import ai.kilocode.client.settings.auth.DeviceOAuthText
import ai.kilocode.client.ui.RoundedContentPanel
import ai.kilocode.client.ui.UiStyle
import ai.kilocode.client.ui.layout.HAlign
import ai.kilocode.client.ui.layout.Stack
import ai.kilocode.client.ui.layout.VAlign
import ai.kilocode.client.ui.layout.align
import ai.kilocode.client.util.UiTimerSource
import ai.kilocode.client.util.UiTimers
import ai.kilocode.log.KiloLog
import ai.kilocode.rpc.dto.EnterpriseSigninDto
import ai.kilocode.rpc.dto.EnterpriseStatusDto
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.components.service
import com.intellij.ui.DocumentAdapter
import com.intellij.ui.components.ActionLink
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextField
import com.intellij.util.concurrency.annotations.RequiresEdt
import com.intellij.util.text.DateFormatUtil
import com.intellij.util.ui.AsyncProcessIcon
import com.intellij.util.ui.FormBuilder
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.components.BorderLayoutPanel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.awt.BorderLayout
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.event.DocumentEvent

internal enum class OrgMode { HIDDEN, SIGNED_IN, ENROLLED, OFFER, FORM, STARTING, PENDING, FAILED }

private sealed interface OrgFlow {
    data object Idle : OrgFlow
    data object Starting : OrgFlow
    data class Pending(val signin: EnterpriseSigninDto) : OrgFlow
    data class Failed(val message: String) : OrgFlow
}

/**
 * The self-hosted organization this device is enrolled in, above the Kilo account on the profile
 * page: who is signed in, the policy in force and why the agent is blocked, plus device sign-in and
 * sign-out. The CLI owns all of it; this shows what `kilo serve` reports, and nothing at all when
 * the CLI has no organization support.
 *
 * Only the current state is visible, so the panel is as tall as what it shows: a device that is not
 * enrolled gets one link, not the room a sign-in code needs.
 */
internal class OrganizationUi(
    private val cs: CoroutineScope,
    private val enterprise: KiloEnterpriseService = service(),
    private val browse: (String) -> Unit = { BrowserUtil.browse(it) },
    private val timers: UiTimerSource = UiTimers,
) : JPanel(BorderLayout()) {

    companion object {
        private val LOG = KiloLog.create(OrganizationUi::class.java)
    }

    // -- signed in --
    private val nameLabel = JBLabel().apply { font = UiStyle.Fonts.header() }
    private val userLabel = weak()
    private val policyLabel = weak()
    private val gatewayLabel = weak()
    private val blockedLabel = JBLabel().apply { foreground = UiStyle.Colors.errorLabelForeground() }
    private val refreshLabel = weak()
    val signoutBtn = JButton(KiloBundle.message("profile.enterprise.action.signout"))
        .also { it.addActionListener { signout() } }
    private val signoutRow = signoutBtn.align(HAlign.RIGHT, VAlign.CENTER)
    private val signedIn = card(
        "kilo.enterprise.signedIn",
        nameLabel, userLabel, policyLabel, gatewayLabel, blockedLabel, refreshLabel, signoutRow,
    )

    // -- enrolled, not signed in --
    private val managedLabel = JBLabel()
    private val enrolledError = weak()
    val signinBtn = JButton(KiloBundle.message("profile.enterprise.action.signin"))
        .also { it.addActionListener { signin() } }
    private val enrolled = card(
        "kilo.enterprise.enrolled",
        managedLabel, enrolledError, signinBtn.align(HAlign.LEFT, VAlign.CENTER),
    )

    // -- not enrolled: an unobtrusive way to connect to one --
    val connectLink = ActionLink(KiloBundle.message("profile.enterprise.connect")) { open() }
        .apply { name = "kilo.enterprise.connect" }
    private val offer = connectLink.align(HAlign.LEFT, VAlign.CENTER)

    val urlField = JBTextField().apply {
        name = "kilo.enterprise.url"
        emptyText.text = KiloBundle.message("profile.enterprise.url.placeholder")
    }
    val orgField = JBTextField().apply {
        name = "kilo.enterprise.org"
        emptyText.text = KiloBundle.message("profile.enterprise.org.placeholder")
    }
    val formSigninBtn = JButton(KiloBundle.message("profile.enterprise.action.signin"))
        .also { it.addActionListener { signin() } }
    private val formCancelBtn = JButton(KiloBundle.message("profile.login.cancel"))
        .also { it.addActionListener { close() } }
    private val form = RoundedContentPanel(UiStyle.Gap.pad(), UiStyle.Gap.xl()).apply {
        name = "kilo.enterprise.form"
        addToCenter(Stack.vertical(UiStyle.Gap.md())
            .next(JBLabel(KiloBundle.message("profile.enterprise.connect")).apply { font = UiStyle.Fonts.bold() })
            .next(FormBuilder.createFormBuilder()
                .addLabeledComponent(KiloBundle.message("profile.enterprise.url"), urlField)
                .addLabeledComponent(KiloBundle.message("profile.enterprise.org"), orgField)
                .panel)
            .next(Stack.horizontal(UiStyle.Gap.md())
                .next(formCancelBtn)
                .next(formSigninBtn)
                .align(HAlign.RIGHT, VAlign.CENTER)))
    }

    // -- sign-in in progress --
    private val startingIcon = AsyncProcessIcon("KiloEnterpriseStarting").also { it.suspend() }
    private val starting = Stack.horizontal(UiStyle.Gap.sm())
        .next(startingIcon)
        .next(weak(KiloBundle.message("profile.enterprise.starting")))
        .align(HAlign.LEFT, VAlign.CENTER)
    // Holds a fresh code panel for each sign-in, like the provider OAuth flow.
    private val pending = BorderLayoutPanel()
    private var auth: DeviceOAuthPanel? = null

    private val failedLabel = JBLabel().apply { foreground = UiStyle.Colors.errorLabelForeground() }
    private val retryBtn = JButton(KiloBundle.message("profile.login.tryAgain"))
        .also { it.addActionListener { signin() } }
    private val failedCancelBtn = JButton(KiloBundle.message("profile.login.cancel"))
        .also { it.addActionListener { cancel() } }
    private val failed = card(
        "kilo.enterprise.failed",
        failedLabel,
        Stack.horizontal(UiStyle.Gap.md())
            .next(retryBtn)
            .next(failedCancelBtn)
            .align(HAlign.LEFT, VAlign.CENTER),
    )

    private val modes: Map<OrgMode, JComponent> = mapOf(
        OrgMode.SIGNED_IN to signedIn,
        OrgMode.ENROLLED to enrolled,
        OrgMode.OFFER to offer,
        OrgMode.FORM to form,
        OrgMode.STARTING to starting,
        OrgMode.PENDING to pending,
        OrgMode.FAILED to failed,
    )

    private var status: EnterpriseStatusDto? = null
    private var flow: OrgFlow = OrgFlow.Idle
    private var connecting = false
    private var attempt = 0
    private var job: Job? = null

    /** The state shown now; for tests. */
    var mode: OrgMode = OrgMode.HIDDEN
        private set

    init {
        border = JBUI.Borders.empty(UiStyle.Gap.pad(), UiStyle.Gap.xl(), 0, UiStyle.Gap.xl())
        val content = Stack.vertical()
        modes.values.forEach { content.next(it.apply { isVisible = false }) }
        add(content, BorderLayout.NORTH)
        isVisible = false
        val fields = object : DocumentAdapter() {
            override fun textChanged(e: DocumentEvent) = syncForm()
        }
        urlField.document.addDocumentListener(fields)
        orgField.document.addDocumentListener(fields)
        syncForm()
    }

    /** Ask the CLI for the organization status. Stays hidden until it answers. */
    @RequiresEdt
    fun load() {
        val id = attempt
        cs.launch {
            val next = try {
                enterprise.status()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                LOG.warn("organization status unavailable: ${e.message}")
                null
            }
            withContext(edt) {
                if (id != attempt) return@withContext
                status = next
                sync()
            }
        }
    }

    /** Invalidate a sign-in in flight and stop the timers. Safe to call more than once. */
    @RequiresEdt
    fun dispose() {
        attempt++
        job?.cancel()
        job = null
        startingIcon.suspend()
        auth?.dispose()
    }

    // ---- actions ----

    private fun open() {
        connecting = true
        sync()
        urlField.requestFocusInWindow()
    }

    private fun close() {
        connecting = false
        sync()
    }

    // An enrolled device signs in to its own organization; otherwise to the one entered here.
    private fun signin() {
        val current = status ?: return
        val url = if (current.enabled) null else urlField.text.trim()
        val org = if (current.enabled) null else orgField.text.trim()
        val id = ++attempt
        flow = OrgFlow.Starting
        sync()
        job?.cancel()
        job = cs.launch {
            try {
                val started = enterprise.signin(url, org)
                val code = started.status?.signin
                withContext(edt) {
                    if (id != attempt) return@withContext
                    if (code == null) return@withContext fail(started.error)
                    status = started.status
                    flow = OrgFlow.Pending(code)
                    show(code)
                    sync()
                    browse(code.link)
                }
                if (code == null) return@launch
                val done = enterprise.finish()
                withContext(edt) {
                    if (id != attempt) return@withContext
                    val next = done.status ?: return@withContext fail(done.error)
                    status = next
                    flow = OrgFlow.Idle
                    connecting = false
                    sync()
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                withContext(edt) {
                    if (id == attempt) fail(compactLoginError(e))
                }
            }
        }
    }

    private fun cancel() {
        attempt++
        job?.cancel()
        job = null
        flow = OrgFlow.Idle
        sync()
    }

    private fun signout() {
        val id = ++attempt
        signoutBtn.isEnabled = false
        cs.launch {
            val next = try {
                enterprise.signout().also { if (it.status == null) LOG.warn("organization sign-out failed: ${it.error}") }.status
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                LOG.warn("organization sign-out failed", e)
                null
            }
            withContext(edt) {
                signoutBtn.isEnabled = true
                if (id != attempt) return@withContext
                if (next == null) return@withContext load()
                status = next
                sync()
            }
        }
    }

    // ---- state ----

    @RequiresEdt
    private fun fail(message: String?) {
        flow = OrgFlow.Failed(message ?: KiloBundle.message("profile.enterprise.failed"))
        sync()
    }

    @RequiresEdt
    private fun show(code: EnterpriseSigninDto) {
        val panel = DeviceOAuthPanel(
            DeviceOAuthText(
                title = KiloBundle.message("profile.enterprise.signinTitle", name()),
                qrDescription = KiloBundle.message("profile.enterprise.qr.description"),
            ),
            cancel = ::cancel,
            browse = browse,
            prefix = "kilo.enterprise",
            timers = timers,
        )
        auth?.dispose()
        auth = panel
        pending.removeAll()
        pending.addToCenter(panel)
        val left = ((code.expires - System.currentTimeMillis()) / 1000).toInt().coerceAtLeast(0)
        panel.update(DeviceOAuthInfo(code.link, code.code, left, timers.now()))
    }

    private fun target(): OrgMode {
        val current = status ?: return OrgMode.HIDDEN
        if (!current.available) return OrgMode.HIDDEN
        return when (flow) {
            OrgFlow.Starting -> OrgMode.STARTING
            is OrgFlow.Pending -> OrgMode.PENDING
            is OrgFlow.Failed -> OrgMode.FAILED
            OrgFlow.Idle -> when {
                current.user != null -> OrgMode.SIGNED_IN
                current.enabled -> OrgMode.ENROLLED
                connecting -> OrgMode.FORM
                else -> OrgMode.OFFER
            }
        }
    }

    @RequiresEdt
    private fun sync() {
        val current = status
        val target = target()
        if (current != null && target == OrgMode.SIGNED_IN) fill(current)
        if (current != null && target == OrgMode.ENROLLED) {
            text(managedLabel, KiloBundle.message("profile.enterprise.managed", name()))
            text(enrolledError, current.error?.let { KiloBundle.message("profile.enterprise.error", it) })
        }
        (flow as? OrgFlow.Failed)?.let { text(failedLabel, it.message) }
        if (mode == target) return
        if (mode == OrgMode.STARTING) startingIcon.suspend()
        if (mode == OrgMode.PENDING) auth?.dispose()
        modes.forEach { (key, component) -> component.isVisible = key == target }
        if (target == OrgMode.STARTING) startingIcon.resume()
        mode = target
        isVisible = target != OrgMode.HIDDEN
        revalidate()
        repaint()
    }

    @RequiresEdt
    private fun fill(current: EnterpriseStatusDto) {
        nameLabel.text = name()
        val user = current.user ?: return
        userLabel.text = KiloBundle.message("profile.enterprise.signedIn", user.email, user.role)
        text(policyLabel, current.policy?.let {
            KiloBundle.message(
                "profile.enterprise.policy",
                it.version.toString(),
                DateFormatUtil.formatDateTime(it.fetched),
            )
        })
        text(gatewayLabel, current.gateway.takeIf { it.isNotEmpty() }?.let {
            KiloBundle.message("profile.enterprise.gateway", it.joinToString(", "))
        })
        text(blockedLabel, current.blocked)
        text(refreshLabel, current.error?.let { KiloBundle.message("profile.enterprise.error", it) })
        // An organization given by environment variables cannot be signed out of from here.
        signoutRow.isVisible = current.source != "env"
    }

    private fun syncForm() {
        formSigninBtn.isEnabled = urlField.text.isNotBlank() && orgField.text.isNotBlank()
    }

    private fun name(): String =
        status?.org?.let { it.name ?: it.slug } ?: orgField.text.trim()

    // Escaped HTML capped to the body width, so a long message (a budget, a server error) breaks
    // over lines instead of running past the card.
    private fun text(label: JBLabel, value: String?) {
        label.isVisible = value != null
        if (value != null) label.text = UiStyle.Text.wrap(value, UiStyle.Text.bodyWidth())
    }

    // ---- builders ----

    // A rounded card titled like the balance card.
    private fun card(id: String, vararg rows: JComponent) = RoundedContentPanel(UiStyle.Gap.pad(), UiStyle.Gap.xl()).apply {
        name = id
        addToCenter(Stack.vertical(UiStyle.Gap.sm()).apply {
            next(weak(KiloBundle.message("profile.enterprise.title")))
            rows.forEach { next(it) }
        })
    }

    private fun weak(text: String = "") = JBLabel(text).apply { foreground = UiStyle.Colors.weak() }
}
