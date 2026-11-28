import { HubFleetClient } from './hub-fleet-client';

const client = (post: (url: string, body: string) => Promise<{ status: number; text: string }>) => new HubFleetClient('http://hub', post);
const msg = async (p: Promise<unknown>) => (await p.then(() => null, (e: Error) => e.message));

describe('why a template host could not be sealed', () => {
    it('is a short code naming the hub status when the hub refuses the seal', async () => {
        expect(await msg(client(async () => ({ status: 404, text: '{"code":"not_found"}' })).seal('h'))).toBe('seal_refused_404');
        expect(await msg(client(async () => ({ status: 409, text: '{"code":"claim_live"}' })).seal('h'))).toBe('seal_refused_409');
        expect(await msg(client(async () => ({ status: 409, text: '{"code":"refused","cellCode":"not_fleet"}' })).seal('h'))).toBe('seal_refused_409');
    });
    it('is seal_busy_<why> when the cell is still working (a bake in progress, a claim live): the fleet asks again later', async () => {
        expect(await msg(client(async () => ({ status: 409, text: '{"code":"refused","cellCode":"bake_running"}' })).seal('h'))).toBe('seal_busy_bake_running');
        expect(await msg(client(async () => ({ status: 409, text: '{"code":"refused","cellCode":"claim_live"}' })).seal('h'))).toBe('seal_busy_claim_live');
    });
    it('is hub_timeout when the hub does not answer in time and hub_unreachable when it cannot be reached', async () => {
        expect(await msg(client(async () => Promise.reject(new Error('hub request timed out'))).seal('h'))).toBe('hub_timeout');
        expect(await msg(client(async () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.1:443'))).connection('h'))).toBe('hub_unreachable');
    });
    it('is a code when the connection check is refused, and the connection state when the hub answers', async () => {
        expect(await msg(client(async () => ({ status: 500, text: '' })).connection('h'))).toBe('connection_refused_500');
        expect(await client(async () => ({ status: 200, text: '{"cellId":"c1","connected":true}' })).connection('h')).toEqual({ cellId: 'c1', connected: true });
    });
});
