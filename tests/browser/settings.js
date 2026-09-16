export async function chooseSetting(page, id, value) {
  const field = page.locator(`[data-choice-for="${id}"]`);
  const panelId = await field.evaluate(element => element.closest('[role=tabpanel]')?.id);
  if (panelId) await page.locator(`[role=tab][aria-controls="${panelId}"]`).click();
  await field.locator(`[data-value="${value}"]`).click();
}
