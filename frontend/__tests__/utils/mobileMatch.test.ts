import { describe, expect, it } from "vitest";
import { mobileMatches } from "@/utils/mobileMatch";

describe("mobileMatches", () => {
	it("ignores spacing, country code and leading 0", () => {
		for (const query of ["98450 12345", "+91 98450 12345", "098450-12345", "9845012345"]) {
			expect(mobileMatches(query, "9845012345")).toBe(true);
		}
		expect(mobileMatches("9845012345", "+91 98450 12345")).toBe(true);
	});

	it("matches a leading 0 against a country code, both ways", () => {
		expect(mobileMatches("098450 12345", "+91 98450 12345")).toBe(true);
		expect(mobileMatches("+91 98450 12345", "09845012345")).toBe(true);
		expect(mobileMatches("0984", "+91 98450 12345")).toBe(true);
	});

	it("matches a partial number from 3 digits", () => {
		expect(mobileMatches("984", "9845012345")).toBe(true);
		expect(mobileMatches("98", "9845012345")).toBe(false);
	});

	it("does not match other numbers or text queries", () => {
		expect(mobileMatches("9845012399", "9845012345")).toBe(false);
		expect(mobileMatches("ravi", "9845012345")).toBe(false);
		expect(mobileMatches("123", "")).toBe(false);
	});
});
