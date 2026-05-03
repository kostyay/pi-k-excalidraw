import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		files: ["**/*.ts"],
		extends: [tseslint.configs.recommended],
		rules: {
			// We only care about catching syntax/parse errors and obvious bugs.
			// Disable noisy stylistic rules — the codebase has its own conventions.
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/no-unused-vars": "off",
			"@typescript-eslint/ban-ts-comment": "off",
			"@typescript-eslint/no-require-imports": "off",
		},
	},
	{
		ignores: ["node_modules/**"],
	},
);
