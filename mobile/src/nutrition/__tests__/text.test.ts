/// <reference types="jest" />
import { matchWords, normalizeText, stem, words } from '../text';

describe('text matching', () => {
  it('normalizes case, accents and punctuation', () => {
    expect(normalizeText('  Crème Brûlée, (FNDDS)! ')).toBe('creme brulee fndds');
  });

  it('singularizes consistently', () => {
    expect(['eggs', 'berries', 'tomatoes', 'sandwiches', 'hummus', 'glass', 'rice'].map(stem)).toEqual([
      'egg',
      'berry',
      'tomato',
      'sandwich',
      'hummus',
      'glass',
      'rice',
    ]);
  });

  it('drops stop words, short words and duplicates', () => {
    expect(words('Rice, white, cooked, NS as to fat, with a bit of rice')).toEqual(['rice', 'white', 'cooked', 'fat', 'bit']);
  });

  it('counts preparation words half and requires a food word to match', () => {
    const m = matchWords(words('grilled chicken breast'), 'Chicken breast, rotisserie');
    expect(m.recall).toBeCloseTo(2 / 2.5);
    expect(m.precision).toBeCloseTo(2 / 3);
    expect(m.coreMatched).toBe(true);
    expect(matchWords(words('cooked spinach'), 'Rice, white, cooked').coreMatched).toBe(false);
  });
});
