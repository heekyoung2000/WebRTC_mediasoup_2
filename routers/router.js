import express from "express";
import { config } from "dotenv";
import path from "path";

config();

const router = express.Router();
const __dirname = path.resolve();

export default function createRoutes(rooms,gameMode){
    router.get("/", (req, res) => {
    res.sendFile(__dirname + "/public/views/home.html");
    });

    router.get('/testdata', (req, res) => {
        res.json(rooms);
    });

    router.post("/testdata2", (req, res) => {
        const type = req.body;
        console.log(type);
        gameMode = type["selectedValue"];
        console.log("type from client: ", gameMode);
    })

    router.use("/room/:roomName", express.static(path.join(__dirname, "public")));
    return router;
}

