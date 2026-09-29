/// <reference types="jest" />
import { __resetFooterInsetForTests, clearFooterInset, getFooterInset, newFooterKey, setFooterInset, subscribeFooterInset } from '../bannerInset';

beforeEach(() => __resetFooterInsetForTests());

test('the banner clears the focused screen’s footer and drops back when it goes', () => {
  const meal = newFooterKey();
  const changed = jest.fn();
  subscribeFooterInset(changed);
  expect(getFooterInset()).toBe(0);

  setFooterInset(meal, 112.4);
  expect(getFooterInset()).toBe(112);
  expect(changed).toHaveBeenCalledTimes(1);

  setFooterInset(meal, 112.2); // same rounded height: no update
  expect(changed).toHaveBeenCalledTimes(1);

  clearFooterInset(meal);
  expect(getFooterInset()).toBe(0);
});

test('one screen’s cleanup never clears another screen’s footer', () => {
  const review = newFooterKey();
  const weight = newFooterKey();
  setFooterInset(weight, 96);
  // The previous screen's blur cleanup can run after the next screen reported its footer.
  setFooterInset(review, 60);
  clearFooterInset(review);
  expect(getFooterInset()).toBe(96);
  setFooterInset(weight, 0);
  expect(getFooterInset()).toBe(0);
});
