const MODEL = /^(auto|hydrogen|neon|carbon)(?:[-:](low|medium|high))?$/i;
const CHAT_ID = /^[\w-]{1,150}$/;

export function parseModel(id) {
  const match = MODEL.exec(String(id || 'auto').trim());
  if (!match) return null;
  const titleCase = value => value ? value[0].toUpperCase() + value.slice(1).toLowerCase() : null;
  return { model: titleCase(match[1]), level: titleCase(match[2]) };
}

export function geminiBrowserSession(session) {
  return session?.backend === 'gemini-browser' && typeof session.chatId === 'string' && CHAT_ID.test(session.chatId);
}

export function geminiBrowserSessionFor(url) {
  const page = new URL(url);
  const chatId = page.pathname.match(/^\/app\/([\w-]{1,150})\/?$/)?.[1];
  return page.origin === 'https://gemini.google.com' && chatId ? { backend: 'gemini-browser', chatId } : undefined;
}

/** The HTTP path has no independent way to verify the selected thinking level. */
export function needsGeminiBrowser(model, session) {
  return geminiBrowserSession(session) || !!parseModel(model)?.level;
}

const PILL = /^(Auto|Hydrogen|Neon|Carbon)$/;
const visibleText = (page, value) => page.getByText(value, { exact: true }).filter({ visible: true }).first();

/** Check the selected menu row for a semantic selection state or its visible checkmark. */
async function selectedLevel(option) {
  return option.evaluate(label => {
    const row = label.closest('button, [role="menuitemradio"], [role="menuitem"], [role="option"], [mat-menu-item]');
    if (!row) return false;
    if (['aria-checked', 'aria-selected', 'aria-pressed', 'data-selected'].some(name => row.getAttribute(name) === 'true')) return true;
    if (row.getAttribute('data-state') === 'checked') return true;
    return [...row.querySelectorAll('mat-icon, google-symbols, [data-mat-icon-name], [data-icon], svg, .checkmark, .check-icon')].some(icon => {
      const name = [icon.getAttribute('data-mat-icon-name'), icon.getAttribute('data-icon'), icon.getAttribute('aria-label'), icon.textContent.trim()];
      const style = getComputedStyle(icon);
      return !!icon.getClientRects().length && style.visibility !== 'hidden' && style.display !== 'none' &&
        (name.some(value => /^(check|checkmark|check_circle|check_small|done|✓|✔)$/i.test(value || '')) || icon.matches('.checkmark, .check-icon'));
    });
  });
}

/** Select the family and confirm the actual checked thinking level before the caller submits. */
export async function pickModel(page, { model, level }) {
  const pill = page.locator('button, [role="button"]').filter({ hasText: PILL }).filter({ visible: true }).last();
  const current = () => pill.innerText({ timeout: 6000 }).then(text => text.trim());
  if (await current() !== model) {
    await pill.click({ timeout: 6000 });
    if (model === 'Auto') {
      await page.getByText('Auto', { exact: true }).filter({ visible: true }).last().click({ timeout: 6000 });
    } else await visibleText(page, `4 ${model}`).click({ timeout: 6000 });
    await page.waitForTimeout(200);
    if (await current() !== model) throw new Error(`the model picker did not switch to ${model}`);
  }
  if (!level) return;
  const menu = visibleText(page, 'Thinking level');
  const option = visibleText(page, level);
  const openLevels = async () => {
    if (!(await menu.isVisible())) await pill.click({ timeout: 6000 });
    if (!(await option.isVisible())) {
      await menu.hover({ timeout: 6000 });
      if (!(await option.isVisible())) await menu.click({ timeout: 6000 });
      await option.waitFor({ timeout: 6000 });
    }
  };
  await openLevels();
  if (!(await selectedLevel(option))) {
    await option.click({ timeout: 6000 });
    await openLevels();
  }
  if (!(await selectedLevel(option))) throw new Error(`the thinking picker did not confirm ${level}`);
  await page.keyboard.press('Escape');
  if (await menu.isVisible()) await page.keyboard.press('Escape');
}
