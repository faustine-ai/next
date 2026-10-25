import { describe, expect, it } from 'vitest';
import { parseFunctionParams } from './params';

describe('parseFunctionParams', () => {
  it('reads positional, defaulted and typed parameters of exported functions', () => {
    const src = `
import { x } from 'y';
export async function getBook(id: string): Promise<Book | null> { return null; }
export async function listBooks(query: BookQuery = {}): Promise<Page<Book>> { return x; }
export async function extendLoan(id: string, days: number) {}
export function noArgs() {}
export const quickCreateAuthor = async (name: string) => name;
export const bare = async name => name;
export const cached = cache(async (slug: string, opts?: { deep: boolean }) => slug);
export const typed: Handler = async ({ a, b }: Input) => a;
export async function rest(...ids: string[]) {}
export async function withGenerics<T extends object>(input: T, fallback = 'x') {}
`;
    expect(parseFunctionParams(src, 'getBook')).toEqual(['id']);
    expect(parseFunctionParams(src, 'listBooks')).toEqual(['query']);
    expect(parseFunctionParams(src, 'extendLoan')).toEqual(['id', 'days']);
    expect(parseFunctionParams(src, 'noArgs')).toEqual([]);
    expect(parseFunctionParams(src, 'quickCreateAuthor')).toEqual(['name']);
    expect(parseFunctionParams(src, 'bare')).toEqual(['name']);
    expect(parseFunctionParams(src, 'cached')).toEqual(['slug', 'opts']);
    expect(parseFunctionParams(src, 'typed')).toEqual(['input']);
    expect(parseFunctionParams(src, 'rest')).toEqual(['ids']);
    expect(parseFunctionParams(src, 'withGenerics')).toEqual(['input', 'fallback']);
    expect(parseFunctionParams(src, 'missing')).toBeNull();
  });

  it('marks FormData parameters and the previous state of a useActionState action', () => {
    const src = `
'use server';
export async function createBook(_prev: ActionState, formData: FormData): Promise<ActionState> {}
export async function updateBook(id: string, _prev: ActionState, formData: FormData): Promise<ActionState> {}
export async function upload(id: string, formData: FormData) {}
export const save = async (state: FormState | undefined, data: FormData) => state;
`;
    expect(parseFunctionParams(src, 'createBook')).toEqual([{ name: '_prev', kind: 'prevState' }, { name: 'formData', kind: 'formData' }]);
    expect(parseFunctionParams(src, 'updateBook')).toEqual(['id', { name: '_prev', kind: 'prevState' }, { name: 'formData', kind: 'formData' }]);
    expect(parseFunctionParams(src, 'upload')).toEqual(['id', { name: 'formData', kind: 'formData' }]);
    expect(parseFunctionParams(src, 'save')).toEqual([{ name: 'state', kind: 'prevState' }, { name: 'data', kind: 'formData' }]);
  });
});
