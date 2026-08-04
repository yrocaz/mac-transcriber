import { customAlphabet } from "nanoid";

// nanoid-style ids (spec §5): short, random, URL-safe, collision-resistant.
// Alphabet excludes visually ambiguous chars; 12 chars is comfortably
// collision-free for a personal, single-machine job queue.
const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
const generate = customAlphabet(alphabet, 12);

export function newJobId(): string {
  return generate();
}
