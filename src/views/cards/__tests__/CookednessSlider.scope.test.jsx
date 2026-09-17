import React from "react";
import {render,screen,fireEvent} from "@testing-library/react";
import {CookednessSlider} from "../CookednessSlider.jsx";

test("an unrated session can be rated without inheriting or overwriting its day rating",()=>{
 const onSaveDay=jest.fn(),onSaveSessionOverride=jest.fn();
 render(<CookednessSlider date="2026-09-17" dayValue={10} sessionValue={null} onSaveDay={onSaveDay} onSaveSessionOverride={onSaveSessionOverride}/>);
 fireEvent.click(screen.getByRole("button",{name:"Rate this session separately"}));
 const slider=screen.getByRole("slider",{name:"Session fatigue rating"});
 expect(slider).toHaveValue("0");
 fireEvent.change(slider,{target:{value:"3"}});fireEvent.mouseUp(slider);
 expect(onSaveSessionOverride).toHaveBeenCalledWith(3);expect(onSaveDay).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button",{name:"Edit day rating"}));
 expect(screen.getByRole("slider",{name:"Day fatigue rating"})).toHaveValue("10");
});
