import { writable } from 'svelte/store';

export type CreateMode = 'token' | 'launch' | 'both' | 'list' | null;

export const createMode = writable<CreateMode>(null);
