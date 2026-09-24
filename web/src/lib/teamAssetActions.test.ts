import { afterEach, describe, expect, it } from 'vitest';

import {
  dispatchTeamAssetAction,
  TEAM_ASSET_ACTION_EVENT,
  type TeamAssetAction,
  teamAssetActionFromSearch,
  teamAssetActionSearch,
} from './teamAssetActions';

const ACTION: TeamAssetAction = {
  library_id: 'lib_0123456789abcdef',
  asset_id: 'ta_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  action: 'reproduce',
};

const listeners: Array<(event: Event) => void> = [];
function listen(handler: (event: Event) => void) {
  listeners.push(handler);
  window.addEventListener(TEAM_ASSET_ACTION_EVENT, handler);
}
afterEach(() => {
  for (const handler of listeners.splice(0)) window.removeEventListener(TEAM_ASSET_ACTION_EVENT, handler);
});

describe('dispatchTeamAssetAction', () => {
  it('returns false when no listener handles the action', () => {
    expect(dispatchTeamAssetAction(ACTION)).toBe(false);
  });

  it('returns false when a listener sees the action but does not claim it', () => {
    listen(() => {});
    expect(dispatchTeamAssetAction(ACTION)).toBe(false);
  });

  it('returns true when a listener claims it with preventDefault and passes the action as detail', () => {
    let received: unknown = null;
    listen(event => {
      received = (event as CustomEvent<TeamAssetAction>).detail;
      event.preventDefault();
    });
    expect(dispatchTeamAssetAction(ACTION)).toBe(true);
    expect(received).toEqual(ACTION);
  });
});

describe('team asset action query string', () => {
  it('builds the query string', () => {
    expect(teamAssetActionSearch(ACTION)).toBe(
      '?team_asset=lib_0123456789abcdef:ta_01ARZ3NDEKTSV4RRFFQ69G5FAV&team_action=reproduce',
    );
    expect(teamAssetActionSearch({ ...ACTION, action: 'open' })).toContain('team_action=open');
  });

  it('round-trips through the query string', () => {
    expect(teamAssetActionFromSearch(teamAssetActionSearch(ACTION))).toEqual(ACTION);
    const open = { ...ACTION, action: 'open' as const };
    expect(teamAssetActionFromSearch(teamAssetActionSearch(open))).toEqual(open);
  });

  it('reads the action among other query params, with or without the leading ?', () => {
    expect(teamAssetActionFromSearch('project=p1&team_asset=lib_a:ta_b&team_action=open')).toEqual({
      library_id: 'lib_a', asset_id: 'ta_b', action: 'open',
    });
  });

  it.each([
    '',
    '?team_action=reproduce',
    '?team_asset=lib_a:ta_b',
    '?team_asset=lib_a:ta_b&team_action=delete',
    '?team_asset=lib_a&team_action=open',
    '?team_asset=:ta_b&team_action=open',
    '?team_asset=lib_a:&team_action=open',
    '?team_asset=lib_a:ta_b:extra&team_action=open',
  ])('returns null for invalid query %j', search => {
    expect(teamAssetActionFromSearch(search)).toBeNull();
  });
});
