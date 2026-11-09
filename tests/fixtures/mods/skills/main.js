import { shared, setShared } from "herdr";
import { migrateKeys } from "./migrate.js";
migrateKeys(shared, setShared);
