import { describe, it, expect } from "vitest";
import {
	getServerHostHash,
	isTokenExpired,
	isClientSecretExpired,
	type OAuthTokensData,
	type OAuthClientInfo,
} from "../../../src/oauth/storage.js";

describe("getServerHostHash", () => {
	it("generates consistent hash for same URL", () => {
		const hash1 = getServerHostHash("https://api.example.com/mcp");
		const hash2 = getServerHostHash("https://api.example.com/mcp");

		expect(hash1).toBe(hash2);
	});

	it("generates different hashes for different hosts", () => {
		const hash1 = getServerHostHash("https://api.example.com/mcp");
		const hash2 = getServerHostHash("https://other.example.com/mcp");

		expect(hash1).not.toBe(hash2);
	});

	it("generates same hash for same host with different paths", () => {
		const hash1 = getServerHostHash("https://api.example.com/mcp");
		const hash2 = getServerHostHash("https://api.example.com/other/path");

		expect(hash1).toBe(hash2);
	});

	it("generates different hash for same host with different ports", () => {
		const hash1 = getServerHostHash("https://api.example.com:8443/mcp");
		const hash2 = getServerHostHash("https://api.example.com/mcp");

		expect(hash1).not.toBe(hash2);
	});

	it("returns 8 character hash", () => {
		const hash = getServerHostHash("https://api.example.com/mcp");

		expect(hash).toHaveLength(8);
	});

	it("handles invalid URL gracefully", () => {
		const hash = getServerHostHash("not-a-valid-url");

		expect(hash).toHaveLength(8);
		expect(typeof hash).toBe("string");
	});

	it("generates consistent hash for invalid URL", () => {
		const hash1 = getServerHostHash("invalid");
		const hash2 = getServerHostHash("invalid");

		expect(hash1).toBe(hash2);
	});
});

describe("isTokenExpired", () => {
	it("returns false when tokens are undefined", () => {
		expect(isTokenExpired(undefined)).toBe(false);
	});

	it("returns false when expires_at is undefined", () => {
		const tokens: OAuthTokensData = {
			access_token: "token",
			token_type: "Bearer",
		};

		expect(isTokenExpired(tokens)).toBe(false);
	});

	it("returns false when token is not expired", () => {
		const futureTime = Math.floor(Date.now() / 1000) + 3600;
		const tokens: OAuthTokensData = {
			access_token: "token",
			token_type: "Bearer",
			expires_at: futureTime,
		};

		expect(isTokenExpired(tokens)).toBe(false);
	});

	it("returns true when token is expired", () => {
		const pastTime = Math.floor(Date.now() / 1000) - 3600;
		const tokens: OAuthTokensData = {
			access_token: "token",
			token_type: "Bearer",
			expires_at: pastTime,
		};

		expect(isTokenExpired(tokens)).toBe(true);
	});

	it("returns true when token expires exactly now", () => {
		const now = Math.floor(Date.now() / 1000);
		const tokens: OAuthTokensData = {
			access_token: "token",
			token_type: "Bearer",
			expires_at: now,
		};

		expect(isTokenExpired(tokens)).toBe(true);
	});

	it("respects threshold parameter", () => {
		const futureTime = Math.floor(Date.now() / 1000) + 100;
		const tokens: OAuthTokensData = {
			access_token: "token",
			token_type: "Bearer",
			expires_at: futureTime,
		};

		expect(isTokenExpired(tokens, 0)).toBe(false);
		expect(isTokenExpired(tokens, 50)).toBe(false);
		expect(isTokenExpired(tokens, 100)).toBe(true);
		expect(isTokenExpired(tokens, 200)).toBe(true);
	});

	it("uses 0 as default threshold", () => {
		const futureTime = Math.floor(Date.now() / 1000) + 1;
		const tokens: OAuthTokensData = {
			access_token: "token",
			token_type: "Bearer",
			expires_at: futureTime,
		};

		expect(isTokenExpired(tokens)).toBe(false);
	});
});

describe("isClientSecretExpired", () => {
	it("returns false when clientInfo is undefined", () => {
		expect(isClientSecretExpired(undefined)).toBe(false);
	});

	it("returns false when client_secret_expires_at is undefined", () => {
		const clientInfo: OAuthClientInfo = {
			client_id: "client-id",
		};

		expect(isClientSecretExpired(clientInfo)).toBe(false);
	});

	it("returns false when client secret is not expired", () => {
		const futureTime = Math.floor(Date.now() / 1000) + 3600;
		const clientInfo: OAuthClientInfo = {
			client_id: "client-id",
			client_secret: "secret",
			client_secret_expires_at: futureTime,
		};

		expect(isClientSecretExpired(clientInfo)).toBe(false);
	});

	it("returns true when client secret is expired", () => {
		const pastTime = Math.floor(Date.now() / 1000) - 3600;
		const clientInfo: OAuthClientInfo = {
			client_id: "client-id",
			client_secret: "secret",
			client_secret_expires_at: pastTime,
		};

		expect(isClientSecretExpired(clientInfo)).toBe(true);
	});

	it("returns true when client secret expires exactly now", () => {
		const now = Math.floor(Date.now() / 1000);
		const clientInfo: OAuthClientInfo = {
			client_id: "client-id",
			client_secret: "secret",
			client_secret_expires_at: now,
		};

		expect(isClientSecretExpired(clientInfo)).toBe(true);
	});

	it("works without client_secret field", () => {
		const futureTime = Math.floor(Date.now() / 1000) + 3600;
		const clientInfo: OAuthClientInfo = {
			client_id: "client-id",
			client_secret_expires_at: futureTime,
		};

		expect(isClientSecretExpired(clientInfo)).toBe(false);
	});
});
