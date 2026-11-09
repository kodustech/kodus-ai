// Controlled comparison on the real app: previous overlay CSS vs current CSS.
// This is not an old-build benchmark or a claim about the user's GPU/frame rate.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { expect } from 'playwright/test';

export async function comparePolicyOverlayMotion({ page, out, open, close }) {
    const cdp = await page.context().newCDPSession(page);
    const samples = [];
    let layers = [];
    await cdp.send('Performance.enable');
    await cdp.send('LayerTree.enable');
    cdp.on('LayerTree.layerTreeDidChange', (event) => {
        layers = event.layers ?? [];
    });
    // Warm the editor's fields before comparing the two style configurations.
    await open();
    await close();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    try {
        for (const previous of [true, false, false, true]) {
            // Reproduce the former blur, shadow, transition and compositing hint. Content,
            // app build, browser, CPU throttle and interactions stay identical.
            const style = previous
                ? await page.addStyleTag({
                      content: `
                [data-slot="sheet-overlay"] { backdrop-filter: blur(4px) !important; }
                [data-slot="sheet-content"] { animation-duration: 150ms !important; transition-property: color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, backdrop-filter !important; transition-duration: 500ms !important; transition-timing-function: ease-in-out !important; animation-timing-function: ease-in-out !important; will-change: auto !important; box-shadow: -24px 0 32px rgba(0,0,0,.5) !important; }
            `,
                  })
                : null;
            const before = await cdp.send('Performance.getMetrics');
            await page.evaluate(() => {
                const probe = {
                    start: performance.now(),
                    intervals: [],
                    last: null,
                    done: false,
                };
                window.__riskOverlayProbe = probe;
                const frame = (time) => {
                    if (probe.last !== null)
                        probe.intervals.push(time - probe.last);
                    probe.last = time;
                    if (time - probe.start < 1000) requestAnimationFrame(frame);
                    else probe.done = true;
                };
                requestAnimationFrame(frame);
            });
            await open();
            const dialog = page.getByRole('dialog', {
                name: 'Edit policy',
                exact: true,
            });
            await expect(dialog).toBeVisible();
            await expect(page.getByRole('dialog')).toHaveCount(1);
            const css = await dialog.evaluate((node) => {
                const content = getComputedStyle(node);
                const overlay = getComputedStyle(
                    document.querySelector('[data-slot="sheet-overlay"]'),
                );
                return {
                    animationMs: parseFloat(content.animationDuration) * 1000,
                    backdropFilter: overlay.backdropFilter,
                    transitionProperty: content.transitionProperty,
                    transitionDuration: content.transitionDuration,
                    willChange: content.willChange,
                };
            });
            const titleBounds = await dialog
                .getByRole('heading', { name: 'Edit policy', exact: true })
                .boundingBox();
            assert.ok(
                titleBounds && titleBounds.y >= 0,
                'The sheet title must stay inside the viewport.',
            );
            let compositingReasons = [];
            const { root } = await cdp.send('DOM.getDocument');
            const { nodeId } = await cdp.send('DOM.querySelector', {
                nodeId: root.nodeId,
                selector: '[data-slot="sheet-content"]',
            });
            const { node } = await cdp.send('DOM.describeNode', { nodeId });
            const layer = layers.find(
                (item) => item.backendNodeId === node.backendNodeId,
            );
            if (layer) {
                const reasons = await cdp.send('LayerTree.compositingReasons', {
                    layerId: layer.layerId,
                });
                compositingReasons = reasons.compositingReasons;
            }
            await page.waitForFunction(() => window.__riskOverlayProbe?.done);
            const frames = await page.evaluate(() => {
                const values = [...window.__riskOverlayProbe.intervals].sort(
                    (a, b) => a - b,
                );
                delete window.__riskOverlayProbe;
                return {
                    count: values.length,
                    p95FrameMs:
                        values[
                            Math.min(
                                values.length - 1,
                                Math.floor(values.length * 0.95),
                            )
                        ] ?? null,
                    maxFrameMs: values.at(-1) ?? null,
                };
            });
            const after = await cdp.send('Performance.getMetrics');
            const metric = (data, name) =>
                data.metrics.find((m) => m.name === name)?.value ?? 0;
            samples.push({
                case: previous
                    ? 'previous_shared_overlay_styles_on_current_build'
                    : 'current_overlay_css',
                cpuThrottle: 4,
                css,
                frames,
                compositingReasons,
                layoutCount:
                    metric(after, 'LayoutCount') -
                    metric(before, 'LayoutCount'),
            });
            if (!previous) {
                assert.equal(
                    css.backdropFilter,
                    'none',
                    'No full-viewport backdrop blur.',
                );
                assert.ok(
                    css.animationMs <= 200,
                    'Panel animation must settle within 200ms.',
                );
                assert.equal(
                    css.transitionProperty,
                    'none',
                    'Do not transition layout properties.',
                );
            }
            await close();
            await expect(dialog).toHaveCount(0);
            await style?.evaluate((node) => node.remove());
        }
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await open();
        const dialog = page.getByRole('dialog', {
            name: 'Edit policy',
            exact: true,
        });
        await expect(dialog).toBeVisible();
        assert.equal(
            await dialog.evaluate(
                (node) => getComputedStyle(node).animationName,
            ),
            'none',
            'Respect reduced motion.',
        );
        await close();
        writeFileSync(
            `${out}/overlay-motion.json`,
            JSON.stringify(
                {
                    note: 'Controlled CSS comparison on the same app build and CPU throttle; CI frames do not establish user-device FPS.',
                    samples,
                    reducedMotion: 'passed',
                },
                null,
                2,
            ),
        );
    } finally {
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
        await cdp.detach();
    }
}
