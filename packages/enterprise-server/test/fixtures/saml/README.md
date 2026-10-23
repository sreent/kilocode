Self-signed key pairs for the SAML tests, made with
`openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 36500 -subj "/CN=Kilo enterprise test idp"`.
`idp` plays the identity provider the org trusts; `rogue` signs with a key it doesn't. They protect
nothing: never trust them anywhere else.
