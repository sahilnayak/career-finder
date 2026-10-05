// Side-effect module: import it FIRST in a test so targets.mjs (which fixes PROFILE_PATH at
// load time) reads the fixture profile instead of the user's config/profile.yml.
// An explicit CAREER_FINDER_PROFILE in the environment still wins.
import { fileURLToPath } from 'url';
process.env.CAREER_FINDER_PROFILE ||= fileURLToPath(new URL('./profile.test.yml', import.meta.url));
