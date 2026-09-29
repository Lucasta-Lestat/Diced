/// <reference types="jest" />
import {
  CLASSIFY_SYSTEM,
  classifyUserText,
  FOOD_SYSTEM,
  foodPhotoLabel,
  foodUserText,
  RESTAURANT_SYSTEM,
  restaurantUserText,
  SCALE_SYSTEM,
  scaleUserText,
} from '../prompts';

const fixedTime = (ms: number) => `T${ms / 60_000}`;

describe('system prompts', () => {
  it('are constants with no per-request data (cacheable)', () => {
    for (const s of [CLASSIFY_SYSTEM, SCALE_SYSTEM, FOOD_SYSTEM, RESTAURANT_SYSTEM]) {
      expect(s.length).toBeGreaterThan(200);
      expect(s).not.toMatch(/\$\{/);
    }
  });

  it('cover the key rules', () => {
    expect(CLASSIFY_SYSTEM).toMatch(/exactly once/);
    expect(SCALE_SYSTEM).toMatch(/Never guess/);
    expect(SCALE_SYSTEM).toMatch(/body fat/);
    expect(FOOD_SYSTEM).toMatch(/at most 3/);
    expect(FOOD_SYSTEM).toMatch(/more than 10%/);
    expect(FOOD_SYSTEM).toMatch(/leftovers/);
    // A lone "after" photo is flagged, not logged as eaten.
    expect(FOOD_SYSTEM).toMatch(/leftovers_only to true/);
    expect(FOOD_SYSTEM).toMatch(/Don't log the visible leftovers as eaten/);
    expect(RESTAURANT_SYSTEM).toMatch(/report_nutrition exactly once/);
    expect(RESTAURANT_SYSTEM).toMatch(/not a combo or meal deal/);
  });
});

describe('user text builders', () => {
  it('classify names the photo range', () => {
    expect(classifyUserText(1)).toBe('Classify this photo (Photo 1).');
    expect(classifyUserText(16)).toBe('Classify these 16 photos (Photo 1 to Photo 16).');
  });

  it('scale mentions the expected unit and uses recent weight only as a tie-breaker', () => {
    expect(scaleUserText({ expectedUnit: 'kg', recentLb: null })).toMatch(/normally set to kg/);
    const text = scaleUserText({ expectedUnit: 'lb', recentLb: 184.26 });
    expect(text).toMatch(/around 184\.3 lb \(83\.6 kg\)/);
    expect(text).toMatch(/Never use it to fill in digits/);
  });

  it('food labels and timing are relative and time-zone independent', () => {
    expect(foodPhotoLabel(1, 120_000, fixedTime)).toBe('Photo 2 (T2)');
    const text = foodUserText({
      takenAt: [0, 3 * 60_000, 21 * 60_000],
      slot: 'lunch',
      notes: '  ',
      answers: [{ question: 'Dressing?', answer: ' ' }],
      library: [],
      plateDiameterIn: null,
      formatTime: fixedTime,
    });
    expect(text).toContain('Photos: 3, taken over 21 min (Photo 1 at +0 min, Photo 2 at +3 min, Photo 3 at +21 min).');
    expect(text).not.toMatch(/notes|Answers|Usual meals|plate/);
    expect(text.endsWith('Estimate what this person ate.')).toBe(true);
  });

  it('restaurant text carries brand and dish', () => {
    expect(restaurantUserText(' Chipotle ', 'Burrito bowl ')).toMatch(/^Brand \/ restaurant: Chipotle\nItem: Burrito bowl\n/);
  });
});
