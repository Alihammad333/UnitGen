export function formatUsername(firstName, lastName) {
  if (!firstName || !lastName) {
    throw new Error("Both first name and last name are required");
  }

  return `${firstName.trim().toLowerCase()}.${lastName.trim().toLowerCase()}`;
}

export function countWords(sentence) {
  if (typeof sentence !== "string") {
    throw new TypeError("Sentence must be a string");
  }

  const cleaned = sentence.trim();
  if (cleaned.length === 0) {
    return 0;
  }

  return cleaned.split(/\s+/).length;
}

export function parseEmail(email) {
  if (typeof email !== "string" || !email.includes("@")) {
    throw new Error("Invalid email address");
  }

  const [username, domain] = email.split("@");

  if (!username || !domain) {
    throw new Error("Invalid email address");
  }

  return {
    username,
    domain,
  };
}