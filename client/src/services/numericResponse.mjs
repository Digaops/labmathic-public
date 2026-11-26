export const isNumeric = item => item?.questionType === 'numeric';
export const responseValue = item => (isNumeric(item) ? item.numericValue : item.selectedOptionId) ?? null;
export const hasResponse = item => responseValue(item) !== null && responseValue(item) !== '';
export const validNumericInput = value => value === null || value === '' || (typeof value === 'string'
  && /^[+-]?(?:\d{1,9}(?:[.,]\d{1,6})?|[.,]\d{1,6})$/.test(value.trim()));
export const canonicalNumericInput = value => value === null || value === '' ? null : String(Number(value.trim().replace(',','.')));
export const answerPayload = (item,value) => isNumeric(item)
  ? {itemId:item.id,numericValue:value ?? null} : {itemId:item.id,optionId:value ?? null};
