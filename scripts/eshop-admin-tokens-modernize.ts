// Real coding task against eshop (JS/Node): replace the admin theme's root
// design tokens with a modernized palette + Inter typography, as a single,
// fully-specified, single-file change. This is a deliberately mechanical
// first test of the pipeline against eshop (scripts/eshop-real-coding-task.ts
// has never completed a live run) - the exact before/after content is given
// below so the worker's job is verification + correct diff construction,
// not design judgment or multi-file exploration.
import { runRealCodingTask } from './lib/run-real-coding-task.ts';

const TASK = `In this repository, replace the entire contents of src/modules/cms/pages/admin/all/Layout.scss with a modernized version. This file defines the admin theme's root CSS custom properties (design tokens) and base layout styles (html/body/table/#app/.header/.content-wrapper/.footer) - every other admin stylesheet in the repo consumes these tokens via var(--name), so only token VALUES and a few property values are changing here, not any token NAMES or class/selector names.

The file currently contains exactly this (read it yourself first to confirm - it must match before you patch):

\`\`\`scss
:root {
  --primary: #008060;
  --secondary: #111213;
  --surface: #111213;
  --onSurface: #111213;
  --interactive: #2c6ecb;
  --critical: #d72c0d;
  --warning: #ffc453;
  --highlight: #5bcdda;
  --success: #008060;
  --decorative: #ffc96b;
  --border: #8c9196;
  --background: #f6f6f7fc;
  --icon: #5c5f62;
  --textSubdued: #6d7175;
  --divider: #e1e3e5;
  --text: #202223;
  --formFieldBorder: #c9cccf;
  --formFieldBorderShadow: #aeb4b9;
}

html {
  font-size: 62.5%;
}
body {
  font-size: 1.4rem;
  color: #202223;
}
table {
  width: 100%;
  border-collapse: collapse;
  td,
  th {
    border: 1px solid var(--divider);
    padding: 0.5rem;
    text-align: left;
  }
  th {
    vertical-align: top;
  }
  &.listing {
    td,
    th {
      border-left: 0;
      border-right: 0;
      padding: 1rem;
    }
    th {
      border: 0;
      padding-top: 2rem;
      padding-bottom: 2rem;
    }
  }
}
#app {
  background-color: rgba(246, 246, 247, 0.9882352941);
}
.header {
  height: 5.6rem;
  width: 100%;
  padding: 0 1rem;
  box-sizing: border-box;
  display: flex;
  position: fixed;
  top: 0;
  left: 0;
  background-color: #fff;
  box-shadow: 0 2px 2px -1px rgba(0, 0, 0, 0.15);
  z-index: 100;
}
.content-wrapper {
  margin-top: 5.6rem;
  min-height: 100vh;
  .main-content {
    overflow: hidden;
    margin-left: 24rem;
    .main-content-inner {
      padding: 2rem 3rem;
      min-height: 100vh;
    }
  }
}
.footer {
  padding-left: 3rem;
  margin-top: 2rem;
  color: var(--border);
  padding-bottom: 1rem;
  border-top: 1px solid var(--divider);
  padding-top: 1rem;
}
\`\`\`

Replace the ENTIRE file with exactly this new content:

\`\`\`scss
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

:root {
  --primary: #6366f1;
  --secondary: #0f172a;
  --surface: #ffffff;
  --onSurface: #0f172a;
  --interactive: #4f46e5;
  --critical: #dc2626;
  --warning: #f59e0b;
  --highlight: #06b6d4;
  --success: #10b981;
  --decorative: #fbbf24;
  --border: #cbd5e1;
  --background: #f8fafc;
  --icon: #64748b;
  --textSubdued: #64748b;
  --divider: #e2e8f0;
  --text: #0f172a;
  --formFieldBorder: #cbd5e1;
  --formFieldBorderShadow: #94a3b8;
}

@media (prefers-color-scheme: dark) {
  :root {
    --secondary: #f1f5f9;
    --surface: #1e293b;
    --onSurface: #f1f5f9;
    --border: #334155;
    --background: #0f172a;
    --icon: #94a3b8;
    --textSubdued: #94a3b8;
    --divider: #1e293b;
    --text: #f1f5f9;
    --formFieldBorder: #334155;
    --formFieldBorderShadow: #1e293b;
  }
}

html {
  font-size: 62.5%;
}
body {
  font-size: 1.4rem;
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  color: var(--text);
}
table {
  width: 100%;
  border-collapse: collapse;
  td,
  th {
    border: 1px solid var(--divider);
    padding: 0.5rem;
    text-align: left;
  }
  th {
    vertical-align: top;
  }
  &.listing {
    td,
    th {
      border-left: 0;
      border-right: 0;
      padding: 1rem;
    }
    th {
      border: 0;
      padding-top: 2rem;
      padding-bottom: 2rem;
    }
  }
}
#app {
  background-color: var(--background);
}
.header {
  height: 5.6rem;
  width: 100%;
  padding: 0 1rem;
  box-sizing: border-box;
  display: flex;
  position: fixed;
  top: 0;
  left: 0;
  background-color: var(--surface);
  border-bottom: 1px solid var(--divider);
  z-index: 100;
}
.content-wrapper {
  margin-top: 5.6rem;
  min-height: 100vh;
  .main-content {
    overflow: hidden;
    margin-left: 24rem;
    .main-content-inner {
      padding: 2rem 3rem;
      min-height: 100vh;
    }
  }
}
.footer {
  padding-left: 3rem;
  margin-top: 2rem;
  color: var(--textSubdued);
  padding-bottom: 1rem;
  border-top: 1px solid var(--divider);
  padding-top: 1rem;
}
\`\`\`

Steps:
1. readFile src/modules/cms/pages/admin/all/Layout.scss and confirm it matches the "currently contains exactly this" block above.
2. applyPatch a single diff on that same path that transforms the current content into the "new content" block above. This is a full-file rewrite (every line changes or is new) - do not attempt a small targeted hunk, replace the whole file body.
3. readFile the same path again and confirm the result matches the new content above exactly (token names unchanged: --primary, --secondary, --surface, --onSurface, --interactive, --critical, --warning, --highlight, --success, --decorative, --border, --background, --icon, --textSubdued, --divider, --text, --formFieldBorder, --formFieldBorderShadow all still present; only their values changed, plus the new @media (prefers-color-scheme: dark) block and font-family were added).
4. Run runPrettier on this one file only to confirm formatting is clean. Do NOT run runJestTest - this is a stylesheet change with no associated test file, there is nothing to test.
5. Do not touch any other file. Do not explore the rest of the repository - everything you need is already given above.`;

await runRealCodingTask({
  label: 'ESHOP-ADMIN-TOKENS',
  task: TASK,
  trellisTaskSlug: 'eshop-admin-modernize-tokens',
  trellisTaskTitle: 'Eshop admin: modernize root design tokens (Layout.scss)',
});
