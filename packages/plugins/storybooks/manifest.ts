export default {
  name: "storybooks",
  version: "1.0.0",
  displayName: "Storybooks",
  description:
    "Browse a deployed Storybook 8 — stories, components, props, design tokens, and Figma component mapping.",
  logo: "logo.svg",
  categories: ["dev", "design"],
  auth: {
    type: "apikey" as const,
    // Tools do not call ctx.http(). The stored secret is a bearer token, a basic
    // password, or a cookie, and it is attached only to the connected origin.
    // A dummy allow-list makes an accidental ctx.http() fail closed instead of
    // sending that secret to whatever URL a tool was given.
    headerName: "X-Storybooks-Unused",
    allowedHosts: ["storybooks.invalid"],
    fields: [
      {
        key: "baseUrl",
        label: "Storybook URL",
        description:
          "Origin of a deployed Storybook 8 static build, for example https://storybook.example.com. A subpath is kept. Credentials in the URL are rejected.",
        placeholder: "https://storybook.example.com",
      },
      {
        key: "authType",
        label: "Auth type",
        description: "How the deployment authenticates. Public Storybooks use none.",
        options: ["none", "bearer", "basic", "cookie"],
      },
      {
        key: "username",
        label: "Basic auth username",
        description: "Required when auth type is basic. Ignored otherwise.",
        placeholder: "reader",
        optional: true,
      },
      {
        key: "figmaMappings",
        label: "Figma mappings",
        description:
          "Optional JSON array that pins a Figma component to a Storybook component. Each row needs storybookComponent plus figmaName, figmaNodeId, or figmaUrl. Used by storybooks_map_figma_component.",
        placeholder: `[
  {
    "figmaName": "Button",
    "figmaNodeId": "12:34",
    "storybookComponent": "Components/Button",
    "props": { "variant": "primary" }
  }
]`,
        optional: true,
        multiline: true,
      },
      {
        key: "credential",
        label: "Credential",
        description:
          "For none, type none. For bearer, the access token. For basic, the password. For cookie, the Cookie header value (session=…).",
        placeholder: "none",
        secret: true,
      },
    ],
  },
};
