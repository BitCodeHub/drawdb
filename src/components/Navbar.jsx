import { useState } from "react";
import { Link } from "react-router-dom";
import logo from "../assets/logo_light_160.png";
import { SideSheet } from "@douyinfe/semi-ui";
import { IconMenu } from "@douyinfe/semi-icons";

export default function Navbar() {
  const [openMenu, setOpenMenu] = useState(false);

  return (
    <>
      <div className="py-4 px-12 sm:px-4 flex justify-between items-center">
        <div className="flex items-center justify-between w-full">
          <Link to="/" className="flex items-center gap-2">
            <img
              src={logo}
              alt="Tandem Schema"
              className="h-[40px] sm:h-[28px]"
            />
            <span className="text-lg font-bold">
              Tandem <span style={{ color: "#FFAC02" }}>Schema</span>
            </span>
          </Link>
          <div className="md:hidden flex gap-12">
            <Link
              to="/editor"
              className="text-lg font-semibold hover:opacity-70 transition-opacity duration-300"
            >
              Editor
            </Link>
            <Link
              to="/templates"
              className="text-lg font-semibold hover:opacity-70 transition-opacity duration-300"
            >
              Templates
            </Link>
          </div>
        </div>
        <button
          onClick={() => setOpenMenu((prev) => !prev)}
          className="hidden md:inline-block h-[24px]"
        >
          <IconMenu size="extra-large" />
        </button>
      </div>
      <hr />
      <SideSheet
        title={
          <img
            src={logo}
            alt="Tandem Schema"
            className="sm:h-[32px] md:h-[42px]"
          />
        }
        visible={openMenu}
        onCancel={() => setOpenMenu(false)}
        width={window.innerWidth}
      >
        <Link
          to="/editor"
          className="hover:bg-zinc-100 block p-3 text-base font-semibold"
        >
          Editor
        </Link>
        <hr />
        <Link
          to="/templates"
          className="hover:bg-zinc-100 block p-3 text-base font-semibold"
        >
          Templates
        </Link>
      </SideSheet>
    </>
  );
}
