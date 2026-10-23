import {
  createContext,
  createEffect,
  createMemo,
  createResource,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { can as allowed, type Capability } from "@enterprise/protocol/roles"
import { call, token } from "./api"

const me = () => call((api) => api["enterprise.account"]["me.get"]())
export type Me = Awaited<ReturnType<typeof me>>
export type OrgAccess = Me["orgs"][number]

function session() {
  const [account, { refetch }] = createResource(me)
  const signOut = async () => {
    await call((api) => api["enterprise.account"].logout()).catch(() => undefined)
    token.clear()
    location.assign(import.meta.env.BASE_URL)
  }
  return { account, refetch, signOut }
}

const Session = createContext<ReturnType<typeof session>>()

export function SessionProvider(props: ParentProps) {
  return <Session.Provider value={session()}>{props.children}</Session.Provider>
}

export function useSession() {
  const value = useContext(Session)
  if (!value) throw new Error("useSession outside SessionProvider")
  return value
}

// The org a page works on comes from the URL (/admin/:org/...), so every view can be linked to.
// The capability table is the protocol's own, so the console only offers what the server allows.
function scope(orgs: Accessor<ReadonlyArray<OrgAccess>>) {
  const params = useParams<{ org: string }>()
  const navigate = useNavigate()
  const org = createMemo(() => orgs().find((item) => item.slug === params.org) ?? orgs()[0])
  // An unknown or revoked org in the URL lands on the first org the account can reach.
  createEffect(() => {
    if (org().slug !== params.org) navigate(`/${org().slug}`, { replace: true })
  })
  return {
    org,
    slug: () => org().slug,
    can: (capability: Capability) => allowed(org().role, capability),
  }
}

const Org = createContext<ReturnType<typeof scope>>()

export function OrgProvider(props: ParentProps<{ orgs: ReadonlyArray<OrgAccess> }>) {
  return <Org.Provider value={scope(() => props.orgs)}>{props.children}</Org.Provider>
}

export function useOrg() {
  const value = useContext(Org)
  if (!value) throw new Error("useOrg outside OrgProvider")
  return value
}
