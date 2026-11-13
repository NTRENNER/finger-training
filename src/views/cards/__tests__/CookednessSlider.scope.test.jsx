import React from "react";
import {render,screen,fireEvent} from "@testing-library/react";
import {CookednessSlider} from "../CookednessSlider.jsx";

test("a session's own rating is shown and saved for that session only",()=>{
 const onSave=jest.fn();
 render(<CookednessSlider dayValue={0} sessionValue={9} onSave={onSave}/>);
 const slider=screen.getByRole("slider",{name:"Session fatigue rating"});
 expect(slider).toHaveValue("9");
 fireEvent.change(slider,{target:{value:"8"}});fireEvent.mouseUp(slider);
 expect(onSave).toHaveBeenCalledWith(8);
 fireEvent.click(screen.getByRole("button",{name:"clear"}));
 expect(onSave).toHaveBeenLastCalledWith(null);
});

test("a session without its own rating shows a legacy day rating until it gets one",()=>{
 const onSave=jest.fn();
 render(<CookednessSlider dayValue={8} sessionValue={null} onSave={onSave}/>);
 expect(screen.getByRole("slider",{name:"Session fatigue rating"})).toHaveValue("8");
 expect(screen.queryByRole("button",{name:"clear"})).not.toBeInTheDocument();
});

test("an unrated session on an unrated day reads unset",()=>{
 render(<CookednessSlider dayValue={null} sessionValue={null} onSave={jest.fn()}/>);
 expect(screen.getByText("unset")).toBeInTheDocument();
});
