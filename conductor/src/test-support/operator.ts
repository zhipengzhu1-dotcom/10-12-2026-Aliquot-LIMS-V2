import { Email, person } from "../types/actor.js";

/** The person tests act for as the Operator; vitest sets ALIQUOT_OPERATOR to the same email. */
export const TEST_OPERATOR_EMAIL = Email.parse("operator@lab.test");

export const TEST_OPERATOR = person(TEST_OPERATOR_EMAIL);
