import { describe, it, expect, vi } from 'vitest';
import { NavVM, NAV_VIEWS, type NavView } from './nav-vm.js';

describe('NavVM', () => {
  it('starts on dashboard', () => {
    const vm = new NavVM();
    expect(vm.state.activeView).toBe('dashboard');
  });

  it.each(NAV_VIEWS)('navigates to %s', (view: NavView) => {
    const vm = new NavVM();
    vm.navigate(view);
    expect(vm.state.activeView).toBe(view);
  });

  it('notifies subscribers on navigate', () => {
    const vm = new NavVM();
    const listener = vi.fn();
    vm.subscribe(listener);
    vm.navigate('mail');
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({ activeView: 'mail' });
  });

  it('allows multiple subscribers', () => {
    const vm = new NavVM();
    const a = vi.fn();
    const b = vi.fn();
    vm.subscribe(a);
    vm.subscribe(b);
    vm.navigate('usage');
    expect(a).toHaveBeenCalledWith({ activeView: 'usage' });
    expect(b).toHaveBeenCalledWith({ activeView: 'usage' });
  });

  it('unsubscribe stops notifications', () => {
    const vm = new NavVM();
    const listener = vi.fn();
    const unsub = vm.subscribe(listener);
    unsub();
    vm.navigate('agents');
    expect(listener).not.toHaveBeenCalled();
  });

  it('preserves state across navigations', () => {
    const vm = new NavVM();
    vm.navigate('usage');
    vm.navigate('source');
    expect(vm.state.activeView).toBe('source');
  });

  it('all 5 nav views are defined', () => {
    expect(NAV_VIEWS).toHaveLength(5);
    expect(NAV_VIEWS).toContain('dashboard');
    expect(NAV_VIEWS).toContain('agents');
    expect(NAV_VIEWS).toContain('mail');
    expect(NAV_VIEWS).toContain('source');
    expect(NAV_VIEWS).toContain('usage');
  });
});
