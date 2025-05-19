-- CreateTable
CREATE TABLE "Game" (
    "id" SERIAL NOT NULL,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "rival" TEXT NOT NULL,
    "winner" TEXT NOT NULL,
    "numMoves" INTEGER NOT NULL,
    "pay" BOOLEAN NOT NULL,
    "time" INTEGER NOT NULL,
    "playertime1" INTEGER NOT NULL,
    "playertime2" INTEGER NOT NULL,

    CONSTRAINT "Game_pkey" PRIMARY KEY ("id")
);
