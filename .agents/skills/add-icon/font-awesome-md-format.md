# `.font-awesome.md` file format

This file lives in the project root and records the project's Font Awesome configuration. It is read by `/add-icon` to generate correct code and updated by `/setup-fa` when initially configuring Font Awesome. Commit it so the whole team benefits.

## Template

```markdown
# Font Awesome Configuration

Detected by the Font Awesome agent tools. Commit this file so the whole team benefits.

## Integration

- **Method:** [e.g., React components via @fortawesome/react-fontawesome, Kit embed (SVG+JS), CDN, self-hosted web fonts]
- **Version:** [e.g., 7.2.0]
- **License:** [Free or Pro]
- **Kit ID:** [if applicable, or omit — this is the Kit token, e.g. `abc123def4`. It's usable as `--kit-token` with the `fa` CLI (e.g. `fa kit icon ...`, `fa kit icons ...`, `fa kit family-styles ...`) to check what the Kit's subset includes, and `fa search --kit-token <TOKEN>` to search only kit-available icons. `/add-icon` and `/suggest-icon` use it to avoid adding or suggesting icons the Kit doesn't contain.]
- **Kit Revision:** [e.g. 42 -- this is the Kit's revision number, useful for tracking updates. It changes every time a kit is updated, whether by changing its subset, settings, or adding/removing/changing any custom icons. It's found as `kitRevision` in the kit detail from `fa kit show --kit-token <TOKEN>`]
- **CDN URL:** [if applicable, or omit]
- **Families:** [e.g., classic, duotone, sharp, sharp-duotone — list all available families]

## Defaults

- **Style:** [e.g., solid]
- **Family:** [e.g., classic]

## Import Pattern

[Describe how icons are imported/used in this project. Examples:]

- Individual imports: `import { faCartShopping } from '@fortawesome/pro-solid-svg-icons'`
- Component: `<FontAwesomeIcon icon={faCartShopping} />`

## Conventions

[Any project-specific patterns observed, e.g.:]

- Icons are wrapped in a custom `<Icon>` component at `src/components/Icon.tsx`
- Default size is `lg`
```

## When to create

- **`/setup-fa`** creates this file at the end of initial setup.
- **`/add-icon`** creates this file during its discovery step if it doesn't already exist.

## When to update

After any skill run, review whether new information was discovered that is missing from the file — a new import pattern, a family not listed, a wrapper component not documented, a version change, a kitRevision change, etc. Update only the sections that are incomplete or outdated. Do not rewrite sections that are already accurate.
