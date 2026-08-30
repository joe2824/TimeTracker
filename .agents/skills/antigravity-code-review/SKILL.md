---
name: antigravity-code-review
description: >-
  Reviews code changes according to Antigravity standards. Covers architecture,
  performance, security, testing, and review communication culture. Use when
  reviewing PRs or evaluating code quality.
---

# Antigravity Code Review Skill

When reviewing code in Antigravity projects, follow these steps and principles.

## Review Checklist

### 1. Correctness
- Does the code do exactly what it is supposed to do?
- Are business rules implemented correctly?
- Are error conditions handled explicitly?

### 2. Architecture & Clean Code
- Is there any unnecessary duplication (DRY violations)?
- Does each function or class have a single responsibility?
- Are names intention-revealing and unambiguous?
- Are functions small, focused, and readable?
- Is dead or obsolete code removed?

### 3. Performance & Scalability
- Are there obvious `O(n²)` or worse patterns?
- Are database or API calls executed inside loops?
- Are async / I/O operations handled correctly?
- Is pagination or streaming used for large datasets?

### 4. Security & Resilience
- **Secrets, Credentials & Cryptographic Keys**:
  - Zero hardcoded secrets (API keys, private certificates, JWT secrets, passwords, cloud credentials).
  - Dynamic loading via environment variables or secret managers.
  - Entropy & token checks for high-entropy strings and hex/base64 encoded secrets.
- **Injection Vulnerabilities (OWASP Top 10)**:
  - *SQL / NoSQL Injection*: Never build SQL queries with string concatenation or f-strings. Always use parameterized queries or type-safe ORMs (e.g. Drizzle).
  - *Command Injection*: Avoid `shell=True`, `os.system()`, `eval()`, `exec()`, or `child_process.exec()`. Always pass argument lists directly.
  - *Cross-Site Scripting (XSS)*: Ensure user-supplied strings are sanitized before HTML insertion (avoid unescaped templates or raw innerHTML).
  - *Path Traversal*: Validate and sanitize file paths against `../` directory traversal attacks with boundary root checks.
  - *Template Injection (SSTI)*: Disallow untrusted string formatting inside template engines.
- **Authentication & Authorization (AuthN / AuthZ)**:
  - *Broken Object Level Authorization (BOLA / IDOR)*: Verify endpoint logic checks user ownership or role permissions before mutating or fetching records by ID.
  - *Session & Token Validation*: Ensure tokens verify signatures, expiration (`exp`), issuer (`iss`), and prevent algorithm confusion.
  - *Role-Based Access Control (RBAC)*: Ensure route guards and middleware intercept unauthorized requests early.
- **Cryptography & Hashing**:
  - *Modern Hashing*: Use Argon2id, bcrypt, or PBKDF2 with appropriate work factors for passwords and secrets. MD5/SHA-1 strictly forbidden for security.
  - *Symmetric Encryption*: Use AES-GCM or ChaCha20-Poly1305 with unique nonces/IVs per encryption. Avoid ECB mode.
  - *Secure Random Numbers*: Use cryptographically secure random generators (`crypto.getRandomValues`, Node `crypto.randomBytes` / `randomInt`, `secrets`) instead of pseudo-random generators (`Math.random`).
- **Network & Deserialization Security**:
  - *Server-Side Request Forgery (SSRF)*: Validate and whitelist target URLs when making outbound HTTP requests based on user input (disallow internal IP ranges `127.0.0.1`, `10.0.0.0/8`, `169.254.169.254`).
  - *Safe Deserialization*: Disallow unsafe deserialization (`pickle.loads`, unsafe YAML/JSON). Use schema-validated parsers (Zod, Pydantic, TypeScript runtime checks).
- **Error Handling & Resilience**:
  - Log errors meaningfully with context, never swallow errors silently without recovery.
  - Fail closed on security checks.

### 5. Testing & Documentation
- Are unit tests added or updated for new behavior?
- Are edge cases covered (nulls, empty lists, invalid input)?
- Do comments explain why decisions were made?
- Is documentation updated when architecture changes?

## Reviewer Skill Levels

### Junior Reviewer
- Focuses on readability and basic correctness
- Identifies naming issues and long functions
- Uses `[QUESTION]` and `[NITPICK]` tags

### Mid-Level Reviewer
- Identifies SOLID violations and performance risks
- Flags missing edge-case tests
- Uses `[SUGGESTION]` and limited `[BLOCKER]`

### Senior Reviewer (Antigravity Standard)
- Evaluates architectural impact and systemic risk
- Identifies technical debt early
- Explains trade-offs clearly
- Writes solution-oriented `[BLOCKER]` comments
- Uses `[KUDOS]` to reinforce good practices

## How to Provide Feedback
- Be specific about what needs to change
- Explain why, not just what
- Suggest alternatives when possible
- Critique the code, never the person

## Reviewer Comment Tags
- `[BLOCKER]` — Must be fixed before merge
- `[SUGGESTION]` — Recommended improvement
- `[NITPICK]` — Minor, non-blocking issue
- `[QUESTION]` — Clarification only
- `[KUDOS]` — Positive feedback

