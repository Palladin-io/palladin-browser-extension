export function mountRedditLogin() {
  // Reduced from the empty public Reddit login inspected on 2026-10-07.
  document.body.innerHTML = '<auth-flow-manager></auth-flow-manager>';
  const root = document.querySelector("auth-flow-manager")!.attachShadow({ mode: "open" });
  root.innerHTML = `<auth-flow-login><faceplate-form id="login"><auth-flow-modal>
    <fieldset><faceplate-text-input id="login-username"></faceplate-text-input></fieldset>
    <fieldset><faceplate-text-input id="login-password"></faceplate-text-input></fieldset>
    <button>Log in</button>
  </auth-flow-modal></faceplate-form></auth-flow-login>`;
  const usernameHost = root.querySelector("#login-username")!;
  const passwordHost = root.querySelector("#login-password")!;
  usernameHost.attachShadow({ mode: "open" }).innerHTML = '<label><input type="text" name="username" autocomplete="username webauthn"></label>';
  passwordHost.attachShadow({ mode: "open" }).innerHTML = '<label><input type="password" name="password" autocomplete="current-password"></label>';
  return {
    root,
    container: root.querySelector("faceplate-form") as HTMLElement,
    usernameHost, passwordHost,
    username: usernameHost.shadowRoot!.querySelector("input")!,
    password: passwordHost.shadowRoot!.querySelector("input")!,
  };
}
