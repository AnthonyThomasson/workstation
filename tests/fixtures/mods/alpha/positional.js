import { shared } from "herdr";
import { migrate, migrateBad } from "./migrate.js";
migrate(shared);
migrateBad(shared);
