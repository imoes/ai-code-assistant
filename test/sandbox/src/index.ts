import { UserService } from "./services/userService";

const svc = new UserService();
console.log(svc.findAll());
